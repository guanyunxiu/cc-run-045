import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
  BlockDoc,
  BlockRegistry,
  CLIPBOARD_MIME,
  copyBlocks,
  parseClipboard,
  pasteBlocks,
  pastePlainText,
  toDataTransfer,
  type InlineAttributes,
} from '@blockeditor/core';
import { bindIndexedDB } from '../offline/persistence.js';
import { SyncQueue } from '../offline/sync-queue.js';
import { NetworkManager, type ConnectionPhase } from '../network/network.js';
import { BlockRenderer } from '../render/block-renderer.js';
import { RemoteCursorLayer } from '../render/remote-cursor-layer.js';
import type { BlockSelection, InlineMark, TextBinding } from '../render/text-binding.js';
import {
  buildAwarenessState,
  colorForUser,
  type AwarenessState,
  type RemoteUser,
} from './awareness-state.js';

export interface SessionConfig {
  docId: string;
  user: { id: string; name: string };
  token: () => string | null;
  wsBaseUrl: string;
  httpBaseUrl: string;
  registry?: BlockRegistry;
}

export interface Caret {
  blockId: string;
  /** 光标端偏移（折叠光标时 from === to）。 */
  index: number;
}

/** 会话内保存的选区：from/to 已排序，from === to 表示折叠光标。 */
interface SelectionRange {
  blockId: string;
  from: number;
  to: number;
}

/**
 * EditorSession —— 单文档编辑会话的装配根。
 *
 * 启动顺序保证"离线优先"：
 *  1. IndexedDB 先加载本地 Yjs 状态（无网也可立即编辑）；
 *  2. BlockDoc / 渲染引擎基于本地状态工作；
 *  3. 网络层后台握手，增量合并远端、幂等推送离线队列。
 */
export class EditorSession {
  readonly yDoc: Y.Doc;
  readonly blockDoc: BlockDoc;
  readonly awareness: Awareness;
  readonly user: RemoteUser;

  private persistence = null as unknown as ReturnType<typeof bindIndexedDB>;
  private queue: SyncQueue | null = null;
  private network: NetworkManager | null = null;
  private renderer: BlockRenderer | null = null;
  private cursorLayer: RemoteCursorLayer | null = null;
  private selection: SelectionRange | null = null;
  /** 折叠光标处继续输入时套用的行内格式（随工具栏切换更新）。 */
  private activeMarks: InlineAttributes = {};
  private statusListeners = new Set<(phase: ConnectionPhase, detail?: string) => void>();
  private remoteListeners = new Set<(states: Map<number, AwarenessState>) => void>();

  constructor(public readonly config: SessionConfig) {
    this.yDoc = new Y.Doc();
    this.blockDoc = new BlockDoc(this.yDoc, {
      registry: config.registry ?? BlockRegistry.createDefault(),
      userId: config.user.id,
    });
    this.awareness = new Awareness(this.yDoc);
    this.user = {
      id: config.user.id,
      name: config.user.name,
      color: colorForUser(config.user.id),
    };
    this.awareness.setLocalStateField('user', this.user);
    this.awareness.setLocalStateField('cursor', null);
  }

  /** 1) 挂载到容器 DOM；2) 加载本地状态；3) 发起协同连接。 */
  async mount(container: HTMLElement): Promise<void> {
    // 本地持久化先于渲染：synced 后 DOM 直接呈现离线缓存内容。
    this.persistence = bindIndexedDB(this.yDoc, this.config.docId);
    this.queue = new SyncQueue(this.persistence.queue);
    await this.persistence.whenSynced;

    // 起始段落不能在此处无条件插入：本地 IndexedDB 为空不代表远端也为空，
    // 每个客户端各插一段会在新文档上合出多个空段落。
    // 等首轮同步确认服务端（以及本地缓存）都没有块后再插，见 onInitialSync。

    this.renderer = new BlockRenderer(this.blockDoc, container, {
      onBindingCreated: (binding) => this.wireBinding(binding),
    });
    this.cursorLayer = new RemoteCursorLayer(this.awareness, this.renderer, container);
    this.awareness.on('change', () => this.emitRemotes());

    this.network = new NetworkManager({
      blockDoc: this.blockDoc,
      yDoc: this.yDoc,
      awareness: this.awareness,
      queue: this.queue!,
      docId: this.config.docId,
      token: this.config.token,
      wsUrl: `${this.config.wsBaseUrl}/collab/ws`,
      httpUrl: this.config.httpBaseUrl,
      onInitialSync: () => this.seedIfEmpty(),
    });
    this.network.onPhase = (phase, detail) => {
      for (const listener of this.statusListeners) listener(phase, detail);
    };
    this.network.start();

    // 周期广播光标（页面失焦时也让对端看到最后位置）。
    window.addEventListener('beforeunload', this.handleBeforeUnload);
  }

  destroy(): void {
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    this.network?.stop();
    this.cursorLayer?.destroy();
    this.renderer?.destroy();
    this.awareness.destroy();
    this.persistence?.destroy();
    this.yDoc.destroy();
  }

  /**
   * 插入唯一的起始空段落。
   *
   * 只能在首轮协同同步完成后调用一次：此刻本地 Y.Doc 已合并服务端状态，
   * 本地长度为 0 才意味着"远端也没有块"。两人先后打开新文档时，
   * 后打开的人会先收到先打开者插入的段落，本地不再为空，便不会重复垫段。
   */
  private seeded = false;
  private seedIfEmpty(): void {
    if (this.seeded) return;
    this.seeded = true;
    if (this.blockDoc.length === 0) {
      const id = this.blockDoc.createBlock({ type: 'paragraph' });
      this.setCaret({ blockId: id, index: 0 });
    }
  }

  // -------------------------------------------------------------------------
  // 块渲染接线：TextBinding 的编辑意图 -> BlockDoc Yjs 事务
  // -------------------------------------------------------------------------

  private wireBinding(binding: TextBinding): void {
    binding.onEdit = (action) => {
      const id = binding.node.id;
      switch (action.type) {
        case 'insert':
          this.blockDoc.insertText(id, action.index, action.text, { ...this.activeMarks });
          this.setCaret({ blockId: id, index: action.index + action.text.length });
          break;
        case 'delete':
          this.blockDoc.deleteText(id, action.index, action.length);
          this.setCaret({ blockId: id, index: action.index });
          break;
        case 'split': {
          const { newId } = this.blockDoc.splitBlock(id, action.index);
          this.setCaret({ blockId: newId, index: 0 });
          break;
        }
        case 'merge': {
          const result = this.blockDoc.mergeWithPrevious(id);
          if (result) this.setCaret({ blockId: result.targetId, index: result.caretIndex });
          break;
        }
      }
    };
    binding.onSelectionChange = (selection) => {
      this.updateSelection(selection);
    };
    binding.onToggleMark = (mark) => this.toggleMark(mark);
  }

  /** 同步选区到会话 / awareness；折叠光标才移动 DOM 焦点，非折叠选区只记录。 */
  private updateSelection(selection: BlockSelection | null): void {
    if (!selection) return;
    const from = Math.min(selection.anchor, selection.head);
    const to = Math.max(selection.anchor, selection.head);
    this.selection = { blockId: selection.blockId, from, to };
    // caret 变化经 awareness 以二进制增量广播给房间内其他用户。
    this.awareness.setLocalStateField('cursor', { blockId: selection.blockId, index: to });
    if (from === to) {
      // 光标（非选区）：渲染层负责把焦点落到对应块。
      this.renderer?.focusBlock(selection.blockId, to);
    }
  }

  private setCaret(caret: Caret): void {
    this.selection = { blockId: caret.blockId, from: caret.index, to: caret.index };
    // caret 变化经 awareness 以二进制增量广播给房间内其他用户。
    this.awareness.setLocalStateField('cursor', { blockId: caret.blockId, index: caret.index });
    this.renderer?.focusBlock(caret.blockId, caret.index);
  }

  get currentCaret(): Caret | null {
    return this.selection ? { blockId: this.selection.blockId, index: this.selection.to } : null;
  }

  // -------------------------------------------------------------------------
  // 工具栏操作
  // -------------------------------------------------------------------------

  /**
   * 切换当前选区上的行内格式（加粗 / 斜体 / …）。
   *
   *  - 非折叠选区：区间内已全部带有该格式则取消，否则加上。格式经
   *    BlockDoc.formatText 走本地事务（LOCAL_ORIGIN），与打字同一条链路：
   *    可同步、可撤销；Y.XmlText.format 只改单个属性，其余格式保留，
   *    所以同一选区可以叠加多种格式。
   *  - 折叠光标：只切换"后续输入"的预设格式，不产生事务。
   */
  toggleMark(mark: InlineMark): void {
    let range = this.selection;
    // 工具栏点击后浏览器选区可能已被折叠，优先用当前 DOM 选区校正。
    const domSelection = this.renderer?.getBinding(range?.blockId ?? '')?.getSelection() ?? null;
    if (domSelection) {
      range = {
        blockId: domSelection.blockId,
        from: Math.min(domSelection.anchor, domSelection.head),
        to: Math.max(domSelection.anchor, domSelection.head),
      };
    }
    if (!range) return;

    if (range.from === range.to) {
      this.activeMarks = { ...this.activeMarks, [mark]: !this.activeMarks[mark] };
      return;
    }

    const node = this.blockDoc.getBlock(range.blockId);
    if (!node) return;
    const active = this.rangeHasMark(node.getDelta(), range.from, range.to, mark);
    this.blockDoc.formatText(range.blockId, range.from, range.to - range.from, {
      [mark]: active ? null : true,
    });
    if (!active) this.activeMarks = { ...this.activeMarks, [mark]: true };
    else this.activeMarks = { ...this.activeMarks, [mark]: null };
    // 事务回流会替换行内 DOM，重新恢复选区，便于再次点击取消。
    this.renderer?.getBinding(range.blockId)?.setSelection(range.from, range.to);
  }

  /** 区间内是否每一段非空文本都已带有该格式。 */
  private rangeHasMark(
    delta: { insert?: string; attributes?: InlineAttributes }[],
    from: number,
    to: number,
    mark: InlineMark,
  ): boolean {
    let offset = 0;
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue;
      const next = offset + op.insert.length;
      if (next > from && offset < to && !op.attributes?.[mark]) return false;
      offset = next;
    }
    return true;
  }

  setBlockType(type: string, attrs?: Record<string, unknown>): void {
    const caret = this.currentCaret;
    if (caret) {
      this.blockDoc.setBlockType(caret.blockId, type, attrs);
    }
  }

  setHeading(level: number): void {
    this.setBlockType('heading', { level });
  }

  insertBlock(type: string): void {
    const caret = this.currentCaret;
    const index = caret ? this.blockDoc.indexOf(caret.blockId) + 1 : this.blockDoc.length;
    const id = this.blockDoc.createBlock({ type, index });
    this.setCaret({ blockId: id, index: 0 });
  }

  moveBlock(id: string, toIndex: number): void {
    this.blockDoc.moveBlock(id, toIndex);
  }

  deleteBlock(id: string): void {
    this.blockDoc.deleteBlock(id);
  }

  undo(): void {
    this.blockDoc.undo();
  }

  redo(): void {
    this.blockDoc.redo();
  }

  // -------------------------------------------------------------------------
  // 全局块复制 / 粘贴（与系统剪贴板互通，纯文本兜底）
  // -------------------------------------------------------------------------

  copySelected(ids: string[]): void {
    const data = copyBlocks(this.blockDoc, ids);
    const payload = toDataTransfer(data);
    void navigator.clipboard?.writeText(payload.text).catch(() => undefined);
    // 富格式暂存到 window 级缓冲，供同域 paste 读取（浏览器 clipboard 写自定义 MIME 受限）。
    blockClipboardCache.set(this.config.docId, payload.json);
  }

  copyCurrentBlock(): void {
    const caret = this.currentCaret;
    if (caret) this.copySelected([caret.blockId]);
  }

  /**
   * 粘贴入口。优先读取块格式（DataTransfer / 同域缓存），
   * 否则将外部纯文本按行拆为段落块。返回是否已处理。
   */
  paste(event: ClipboardEvent): boolean {
    const caret = this.currentCaret;
    if (!caret) return false;
    const dataTransfer = event.clipboardData;
    const blockJson =
      dataTransfer?.getData(CLIPBOARD_MIME) ||
      blockClipboardCache.get(this.config.docId) ||
      null;
    const atIndex = this.blockDoc.indexOf(caret.blockId) + 1;

    if (blockJson) {
      const parsed = parseClipboard(blockJson);
      if (parsed) {
        event.preventDefault();
        const result = pasteBlocks(this.blockDoc, parsed, atIndex);
        if (result.caret) this.setCaret(result.caret);
        return true;
      }
    }
    const text = dataTransfer?.getData('text/plain');
    if (text) {
      event.preventDefault();
      const result = pastePlainText(this.blockDoc, text, atIndex);
      if (result.caret) this.setCaret(result.caret);
      return true;
    }
    return false;
  }

  copy(event: ClipboardEvent): boolean {
    const caret = this.currentCaret;
    if (!caret) return false;
    const data = copyBlocks(this.blockDoc, [caret.blockId]);
    const payload = toDataTransfer(data);
    event.clipboardData?.setData(CLIPBOARD_MIME, payload.json);
    event.clipboardData?.setData('text/plain', payload.text);
    blockClipboardCache.set(this.config.docId, payload.json);
    event.preventDefault();
    return true;
  }

  // -------------------------------------------------------------------------
  // 状态订阅
  // -------------------------------------------------------------------------

  onStatus(listener: (phase: ConnectionPhase, detail?: string) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRemoteUsers(listener: (states: Map<number, AwarenessState>) => void): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  private emitRemotes(): void {
    const map = new Map<number, AwarenessState>();
    this.awareness.getStates().forEach((raw, clientId) => {
      if (clientId === this.awareness.clientID) return;
      if (raw.user && raw.cursor) map.set(clientId, raw as AwarenessState);
    });
    for (const listener of this.remoteListeners) listener(map);
  }

  private readonly handleBeforeUnload = (): void => {
    // 通知房间光标离线；y-indexeddb 自身保证 Yjs 状态已落盘。
    this.awareness.setLocalStateField('cursor', null);
  };
}

/** 同标签页块剪贴板兜底缓存（key: docId）。 */
const blockClipboardCache = new Map<string, string>();
