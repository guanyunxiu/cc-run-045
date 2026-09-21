import * as Y from 'yjs';
import { BlockNode, createYBlock, type YBlock } from './block-node.js';
import { BlockRegistry } from './registry.js';
import type {
  BlockAttributes,
  BlockChange,
  BlockChangeType,
  BlockMeta,
  CreateBlockOptions,
  DeltaItem,
  DocChangeEvent,
  DocChangeHandler,
  InlineAttributes,
} from './types.js';

/**
 * 事务 origin 约定 —— 渲染层、持久化层、撤销栈都依赖它区分变更来源：
 *  - LOCAL_ORIGIN：本机用户主动编辑（进入 UndoManager，可撤销）
 *  - REMOTE_ORIGIN：WebSocket / 长轮询拉取的远端更新（不可撤销）
 *  - UNDO_ORIGIN / REDO_ORIGIN：Yjs UndoManager 自动产生（在线离线共用同一栈）
 */
export const LOCAL_ORIGIN: unique symbol = Symbol('blockdoc:local');
export const REMOTE_ORIGIN: unique symbol = Symbol('blockdoc:remote');
export const UNDO_ORIGIN: unique symbol = Symbol('blockdoc:undo');
export const REDO_ORIGIN: unique symbol = Symbol('blockdoc:redo');
function generateBlockId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 按字符串偏移切分 Delta，返回 start 之后的片段（保留行内属性）。 */
export function sliceDeltaAfter(delta: DeltaItem[], start: number): DeltaItem[] {
  const out: DeltaItem[] = [];
  let offset = 0;
  for (const op of delta) {
    if (typeof op.insert === 'string') {
      const len = op.insert.length;
      if (offset + len > start) {
        out.push({
          insert: op.insert.slice(Math.max(0, start - offset)),
          ...(op.attributes ? { attributes: op.attributes } : {}),
        });
      }
      offset += len;
    }
  }
  return out;
}

export interface BlockDocOptions {
  /** 复用已有全局注册表；默认创建含四类内置块的注册表。 */
  registry?: BlockRegistry;
  /** 当前用户 ID，写入新块的 createdBy。 */
  userId?: string | null;
  /** Yjs 文档在顶层使用的命名空间（默认 'blockdoc'）。 */
  rootKey?: string;
}

/**
 * BlockDoc —— 块文档模型内核。
 *
 * 所有块的新增 / 删除 / 修改 / 移动都封装为带 LOCAL_ORIGIN 的 Yjs 事务；
 * 远端更新以 REMOTE_ORIGIN applyUpdate 进入同一棵 CRDT 树，
 * 冲突合并由 Yjs 自动完成（无锁、无中心裁决）。
 */
export class BlockDoc {
  readonly doc: Y.Doc;
  readonly registry: BlockRegistry;
  userId: string | null;

  private readonly yBlocks: Y.Map<YBlock>;
  private readonly yOrder: Y.Array<string>;
  /** YBlock -> blockId，用于在深度 observe 事件中反查块 ID。 */
  private readonly blockToId = new WeakMap<YBlock, string>();

  private readonly undoManager: Y.UndoManager;
  private readonly handlers = new Set<DocChangeHandler>();
  /** 一次事务内累积的归一化变更，afterTransaction 时统一派发。 */
  private pending = new Map<string, BlockChangeType>();
  private transactionOrigin: unknown = null;

  constructor(doc: Y.Doc, options: BlockDocOptions = {}) {
    this.doc = doc;
    this.registry = options.registry ?? BlockRegistry.createDefault();
    this.userId = options.userId ?? null;
    const rootKey = options.rootKey ?? 'blockdoc';

    this.yBlocks = doc.getMap<YBlock>(`${rootKey}:blocks`);
    this.yOrder = doc.getArray<string>(`${rootKey}:order`);

    // 恢复已有映射（IndexedDB 重新加载 / 服务端房间持久化场景）。
    for (const [id, yBlock] of this.yBlocks) this.blockToId.set(yBlock, id);

    this.yBlocks.observeDeep((events) => this.collectBlockEvents(events));
    this.yOrder.observe((event) => {
      // 规范化 order：同一块 ID 在数组里只允许出现一次，保留第一次出现。
      // 空文档的起始段落使用与 docId 绑定的确定性 ID，两个用户同时打开
      // 全新文档时会各自插入同一 ID，CRDT 合并后这里会出现重复引用；
      // 在产生该变更的同一事务里做确定性删除，所有副本收敛到同一个块，
      // 不会每人各垫一个空段落。
      this.normalizeOrder();
      this.collectOrderEvents(event);
    });
    this.doc.on('afterTransaction', (transaction) => this.flush(transaction));

    // 统一撤销重做栈：仅追踪本地事务；远端合并不进栈，
    // 因此在线 / 离线状态下行为完全一致（"在线离线通用栈"）。
    // captureTimeout=0：每个 transactLocal 是独立撤销单元
    // （createBlock / splitBlock 等内部虽为一个事务，但与其他操作不合并）。
    this.undoManager = new Y.UndoManager([this.yBlocks, this.yOrder], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  get length(): number {
    return this.yOrder.length;
  }

  getIds(): string[] {
    return this.yOrder.toArray();
  }

  getBlock(id: string): BlockNode | null {
    const yBlock = this.yBlocks.get(id);
    return yBlock ? new BlockNode(yBlock) : null;
  }

  getBlockAt(index: number): BlockNode | null {
    const id = this.yOrder.get(index);
    return id ? this.getBlock(id) : null;
  }

  indexOf(id: string): number {
    return this.yOrder.toArray().indexOf(id);
  }

  getMetaList(): BlockMeta[] {
    return this.getIds()
      .map((id) => this.getBlock(id)?.getMeta())
      .filter((m): m is BlockMeta => m !== null && m !== undefined);
  }

  // -------------------------------------------------------------------------
  // 变更订阅（渲染引擎的唯一数据源）
  // -------------------------------------------------------------------------

  on(handler: DocChangeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private mark(id: string, type: BlockChangeType): void {
    const priority: Record<BlockChangeType, number> = { delete: 4, add: 3, move: 2, update: 1 };
    const current = this.pending.get(id);
    if (!current || priority[type] > priority[current]) this.pending.set(id, type);
  }

  private collectBlockEvents(events: Y.YEvent<Y.AbstractType<unknown>>[]): void {
    for (const event of events) {
      if (event.target === this.yBlocks) {
        // 根 Map：块新增 / 删除。
        event.changes.keys.forEach((change, id) => {
          if (change.action === 'delete') {
            this.mark(id, 'delete');
          } else if (change.action === 'add') {
            const yBlock = this.yBlocks.get(id);
            if (yBlock) this.blockToId.set(yBlock, id);
            this.mark(id, 'add');
          } else {
            this.mark(id, 'update');
          }
        });
        continue;
      }
      // 嵌套事件：path[0] 是 yBlocks 中的块 ID。
      const id = event.path[0];
      if (typeof id === 'string' && this.yBlocks.has(id)) this.mark(id, 'update');
    }
  }

  /**
   * 删除 order 中重复的块 ID 引用（保留第一次出现）。
   * 必须在 yOrder.observe 回调中调用：此刻仍处于触发事务内，追加的删除
   * 与原插入同属一个事务、同一增量，各副本观察到同样的合并结果后执行
   * 同样的删除，CRDT 收敛一致。
   */
  private normalizeOrder(): void {
    const seen = new Set<string>();
    const duplicateIndexes: number[] = [];
    this.yOrder.toArray().forEach((id, index) => {
      if (seen.has(id)) duplicateIndexes.push(index);
      else seen.add(id);
    });
    // 从后往前删，避免索引位移。
    for (let i = duplicateIndexes.length - 1; i >= 0; i -= 1) {
      this.yOrder.delete(duplicateIndexes[i], 1);
    }
  }

  private collectOrderEvents(event: Y.YArrayEvent<string>): void {
    for (const item of event.delta) {
      const inserted = Array.isArray(item.insert) ? (item.insert as string[]) : [];
      const deleted = typeof item.delete === 'number' ? item.delete : 0;
      void deleted;
      // insert/delete 的具体 ID 已被块事件归一化为 add/delete；
      // 仍存活的块若顺序变化则标记 move（moveBlock 的删除+插入落在同一事务）。
      for (const id of inserted) {
        if (this.yBlocks.has(id) && this.pending.get(id) !== 'add') this.mark(id, 'move');
      }
    }
  }


  private flush(transaction: Y.Transaction): void {
    if (this.pending.size === 0) return;
    const changes: BlockChange[] = Array.from(this.pending, ([id, type]) => ({ id, type }));
    this.pending = new Map();
    const local = transaction.origin === LOCAL_ORIGIN;
    const event: DocChangeEvent = {
      changes,
      transaction,
      local,
      origin: transaction.origin,
    };
    for (const handler of [...this.handlers]) handler(event);
  }

  // -------------------------------------------------------------------------
  // 事务封装：所有写操作唯一入口
  // -------------------------------------------------------------------------

  /**
   * 在一个本地 Yjs 事务中执行块操作。
   * 同一事务内多次块修改只产生一个二进制增量、一条撤销记录、一次渲染调度。
   */
  transactLocal<T>(fn: () => T): T {
    let result: T;
    this.doc.transact(() => {
      result = fn();
    }, LOCAL_ORIGIN);
    return result!;
  }

  /** 供网络层使用：以远端 origin 应用更新（不进撤销栈）。 */
  applyRemoteUpdate(update: Uint8Array): void {
    this.doc.transact(() => {
      Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
    }, REMOTE_ORIGIN);
  }

  // -------------------------------------------------------------------------
  // 块 CRUD + 移动
  // -------------------------------------------------------------------------

  createBlock(options: CreateBlockOptions): string {
    const type = this.registry.resolveType(options.type);
    const id = options.id ?? generateBlockId();
    if (this.yBlocks.has(id)) throw new Error(`块 ID ${id} 已存在`);
    const now = Date.now();
    const attrs: BlockAttributes = {
      ...this.registry.defaultAttrs(type),
      ...(options.attrs ?? {}),
    };

    this.transactLocal(() => {
      const yBlock = createYBlock({
        id,
        type,
        now,
        createdBy: this.userId,
        parentId: options.parentId ?? null,
        attrs,
      });
      this.yBlocks.set(id, yBlock);
      const index = options.index ?? this.yOrder.length;
      this.yOrder.insert(Math.max(0, Math.min(index, this.yOrder.length)), [id]);
      if (options.content) new BlockNode(yBlock).applyDelta(options.content);
    });
    return id;
  }

  deleteBlock(id: string): void {
    this.transactLocal(() => {
      if (!this.yBlocks.has(id)) return;
      const index = this.yOrder.toArray().indexOf(id);
      if (index >= 0) this.yOrder.delete(index, 1);
      this.yBlocks.delete(id);
    });
  }

  /** 移动块到新位置（toIndex 基于"先移除后插入"语义，直观对应拖拽落点）。 */
  moveBlock(id: string, toIndex: number): void {
    this.transactLocal(() => {
      const order = this.yOrder.toArray();
      const from = order.indexOf(id);
      if (from < 0) return;
      this.yOrder.delete(from, 1);
      const clamped = Math.max(0, Math.min(toIndex, this.yOrder.length));
      this.yOrder.insert(clamped, [id]);
    });
  }

  setBlockType(id: string, type: string, attrs?: BlockAttributes): void {
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      node.setType(this.registry.resolveType(type));
      if (attrs) node.setAttrs(attrs);
    });
  }

  setBlockAttrs(id: string, attrs: BlockAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.setAttrs(attrs));
  }

  setBlockAttr(id: string, key: string, value: unknown): void {
    this.transactLocal(() => this.getBlock(id)?.setAttr(key, value));
  }

  // -------------------------------------------------------------------------
  // 行内文本编辑（全部走 Yjs XmlText 事务）
  // -------------------------------------------------------------------------

  insertText(id: string, index: number, text: string, attributes?: InlineAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.insertText(index, text, attributes));
  }

  deleteText(id: string, index: number, length: number): void {
    this.transactLocal(() => this.getBlock(id)?.deleteText(index, length));
  }

  formatText(id: string, index: number, length: number, attributes: InlineAttributes): void {
    this.transactLocal(() => this.getBlock(id)?.formatText(index, length, attributes));
  }

  /**
   * 在块内 caretIndex 处拆分块。
   * 标题拆出的新块降级为段落；其余类型继承自身类型与属性。
   * 行内格式随文本切片保留。
   */
  splitBlock(id: string, caretIndex: number): { newId: string; caret: { blockId: string; index: number } } {
    const newId = generateBlockId();
    this.transactLocal(() => {
      const node = this.getBlock(id);
      if (!node) return;
      const tailDelta = sliceDeltaAfter(node.getDelta(), caretIndex);
      node.deleteText(caretIndex, Math.max(0, node.text.length - caretIndex));

      const nextType = node.type === 'heading' ? 'paragraph' : node.type;
      const yBlock = createYBlock({
        id: newId,
        type: this.registry.resolveType(nextType),
        now: Date.now(),
        createdBy: this.userId,
        attrs: { ...node.getAttrs() },
      });
      const insertIndex = this.yOrder.toArray().indexOf(id) + 1;
      this.yBlocks.set(newId, yBlock);
      this.yOrder.insert(insertIndex, [newId]);
      if (tailDelta.length) new BlockNode(yBlock).applyDelta(tailDelta);
    });
    return { newId, caret: { blockId: newId, index: 0 } };
  }

  /** 将块合并到上一块末尾（Backspace 于块首时触发）。 */
  mergeWithPrevious(id: string): { targetId: string; caretIndex: number } | null {
    const currentIndex = this.yOrder.toArray().indexOf(id);
    if (currentIndex <= 0) return null;
    const targetId = this.yOrder.get(currentIndex - 1);

    this.transactLocal(() => {
      const target = this.getBlock(targetId);
      const current = this.getBlock(id);
      if (!target || !current) return;
      const caretIndex = target.text.length;
      for (const op of current.getDelta()) {
        if (typeof op.insert === 'string') {
          target.insertText(target.text.length, op.insert, op.attributes);
        }
      }
      const index = this.yOrder.toArray().indexOf(id);
      this.yOrder.delete(index, 1);
      this.yBlocks.delete(id);
      void caretIndex;
    });
    return { targetId, caretIndex: this.getBlock(targetId)?.text.length ?? 0 };
  }

  // -------------------------------------------------------------------------
  // 统一撤销 / 重做（在线离线共用）
  // -------------------------------------------------------------------------

  undo(): void {
    this.undoManager.undo();
  }

  redo(): void {
    this.undoManager.redo();
  }

  canUndo(): boolean {
    return this.undoManager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.undoManager.redoStack.length > 0;
  }

  /** 导出全量状态（首帧同步 / 调试使用）。 */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }
}
