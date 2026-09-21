import { BlockDoc, type BlockNode } from '@blockeditor/core';
import type { DocChangeEvent } from '@blockeditor/core';
import { TextBinding } from './text-binding.js';
import { blockTag, h, headingLevel } from './dom.js';

/** 预估块高度（含 margin），用于虚拟滚动上下衬垫；实际挂载后以真实高度校正。 */
const ESTIMATED_BLOCK_HEIGHT = 44;
const OVERSCAN = 6;

export interface RendererCallbacks {
  onBindingCreated?: (binding: TextBinding) => void;
  onBlockFocus?: (blockId: string, index: number) => void;
  /** 自定义块扩展渲染（迭代 2 表格 / 图片）。 */
  customBlockClass?: (type: string) => string | null;
}

interface MountedBlock {
  id: string;
  wrapper: HTMLElement;
  content: HTMLElement;
  binding: TextBinding;
  height: number;
}

/**
 * BlockRenderer —— 自研独立块渲染引擎。
 *
 *  - 不依赖富文本框架（无 Quill / ProseMirror / Slate 的 DOM 约定）；
 *  - 唯一输入是 BlockDoc 的 DocChangeEvent（Yjs 事务驱动），
 *    按块 ID 做局部增删移动，绝不全局重渲染；
 *  - 内置窗口化（virtual scroll）：仅挂载视口附近的块 DOM，
 *    上下用高度衬垫撑起滚动条，支持数千块流畅滚动；
 *  - 每个块的行内 DOM 由 TextBinding 与 Y.XmlText 双向绑定。
 */
export class BlockRenderer {
  readonly scrollRoot: HTMLElement;
  private readonly topSpacer: HTMLElement;
  private readonly bottomSpacer: HTMLElement;
  private readonly viewport: HTMLElement;
  private readonly mounted = new Map<string, MountedBlock>();
  /** 块 ID -> 实测高度（卸载块也保留，滚动跳动最小）。 */
  private readonly measuredHeights = new Map<string, number>();
  private rafScheduled = false;
  private pendingEvent: DocChangeEvent | null = null;
  private detachDoc: (() => void) | null = null;
  /** 请求把光标放到某块（拆分 / 合并后由会话层调用）。 */
  private pendingFocus: { id: string; index: number } | null = null;

  constructor(
    private readonly doc: BlockDoc,
    container: HTMLElement,
    private readonly callbacks: RendererCallbacks = {},
  ) {
    this.scrollRoot = h('div', 'be-scroll-root');
    this.viewport = h('div', 'be-viewport');
    this.topSpacer = h('div', 'be-spacer');
    this.bottomSpacer = h('div', 'be-spacer');
    this.scrollRoot.append(this.topSpacer, this.viewport, this.bottomSpacer);
    container.replaceChildren(this.scrollRoot);

    this.scrollRoot.addEventListener('scroll', this.scheduleRender, { passive: true });
    window.addEventListener('resize', this.scheduleRender);

    this.detachDoc = this.doc.on((event) => {
      this.pendingEvent = event;
      this.scheduleRender();
    });
    this.render();
  }

  destroy(): void {
    this.detachDoc?.();
    this.scrollRoot.removeEventListener('scroll', this.scheduleRender);
    window.removeEventListener('resize', this.scheduleRender);
    for (const mounted of this.mounted.values()) mounted.binding.destroy();
    this.mounted.clear();
  }

  /** 渲染层请求聚焦（ caret 恢复在 DOM 挂载后的同一帧完成）。 */
  focusBlock(id: string, index: number): void {
    this.pendingFocus = { id, index };
    this.scheduleRender();
  }

  getBinding(id: string): TextBinding | null {
    return this.mounted.get(id)?.binding ?? null;
  }

  // -------------------------------------------------------------------------
  // 变更调度：rAF 合帧，一次事务的多次事件只产生一次 DOM 对齐
  // -------------------------------------------------------------------------

  private scheduleRender = (): void => {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.render(this.pendingEvent ?? undefined);
      this.pendingEvent = null;
    });
  };

  private render(event?: DocChangeEvent): void {
    const ids = this.doc.getIds();
    const { start, end } = this.visibleRange(ids);

    // 1) 卸载视口外的块（保留测量高度）。
    for (const [id, mounted] of this.mounted) {
      const orderIndex = ids.indexOf(id);
      if (orderIndex < start || orderIndex >= end || !this.doc.getBlock(id)) {
        this.measure(mounted);
        mounted.binding.destroy();
        mounted.wrapper.remove();
        this.mounted.delete(id);
      }
    }

    // 2) 挂载视口内缺失的块，并按规范顺序对齐（移动块只做 DOM 位置调整）。
    const changedIds = new Set(event?.changes.map((c) => c.id) ?? []);

    // 计算视口前累计高度 -> topSpacer 高度。
    let topHeight = 0;
    for (let i = 0; i < start; i++) topHeight += this.heightOf(ids[i]);
    this.topSpacer.style.height = `${topHeight}px`;

    let anchor: ChildNode | null = null; // 已挂载窗口的下一个 DOM 锚点
    for (let orderIndex = end - 1; orderIndex >= start; orderIndex--) {
      const id = ids[orderIndex];
      const node = this.doc.getBlock(id);
      if (!node) continue;
      let mounted = this.mounted.get(id);
      if (!mounted) {
        mounted = this.mountBlock(node);
        this.mounted.set(id, mounted);
      } else if (changedIds.has(id)) {
        // 块属性变化（类型 / 级别 / 语言）：更新外壳；
        // 行内文本变化由 TextBinding 自行监听 Y.XmlText 局部刷新。
        this.updateBlockShell(mounted, node);
      }
      // 倒序插入：每次插到当前锚点之前即可保证最终顺序与 ids 一致，
      // 块移动（moveBlock）时只发生 insertBefore，不重建块 DOM。
      this.viewport.insertBefore(mounted.wrapper, anchor);
      anchor = mounted.wrapper;
    }
    // 清理窗口中应不存在的残余节点（理论上卸载阶段已删除，这里防御性兜底）。
    for (const child of [...this.viewport.children]) {
      const id = (child as HTMLElement).dataset.blockId;
      const idx = id ? ids.indexOf(id) : -1;
      if (id && (idx < start || idx >= end)) child.remove();
    }

    // 3) 底部衬垫 = 视口后块的预估高度和。
    let bottomHeight = 0;
    for (let i = end; i < ids.length; i++) bottomHeight += this.heightOf(ids[i]);
    this.bottomSpacer.style.height = `${bottomHeight}px`;

    // 4) 焦点恢复。
    if (this.pendingFocus) {
      const { id, index } = this.pendingFocus;
      const mounted = this.mounted.get(id);
      if (mounted) {
        const range = document.createRange();
        const textNode = firstTextNode(mounted.content) ?? mounted.content;
        const offset = Math.min(index, textNode.textContent?.length ?? 0);
        range.setStart(textNode, textNode === mounted.content ? Math.min(offset, mounted.content.childNodes.length) : offset);
        range.collapse(true);
        const sel = document.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        mounted.content.focus();
        this.pendingFocus = null;
        this.callbacks.onBlockFocus?.(id, index);
      }
    }
  }

  private visibleRange(ids: string[]): { start: number; end: number } {
    if (ids.length === 0) return { start: 0, end: 0 };
    const scrollTop = this.scrollRoot.scrollTop;
    const viewHeight = this.scrollRoot.clientHeight;

    // 起点：累计高度首次进入 scrollTop 的块。
    let acc = 0;
    let start = ids.length;
    for (let i = 0; i < ids.length; i++) {
      const blockHeight = this.heightOf(ids[i]);
      if (acc + blockHeight > scrollTop) {
        start = i;
        break;
      }
      acc += blockHeight;
    }
    start = Math.max(0, start - OVERSCAN);

    // 终点：累计覆盖视口高度后的块。
    let end = start;
    let windowHeight = 0;
    while (end < ids.length && windowHeight < viewHeight) {
      windowHeight += this.heightOf(ids[end]);
      end += 1;
    }
    return { start: Math.max(0, start), end: Math.min(ids.length, end + OVERSCAN) };
  }

  private heightOf(id: string): number {
    return this.measuredHeights.get(id) ?? ESTIMATED_BLOCK_HEIGHT;
  }

  private measure(mounted: MountedBlock): void {
    const height = mounted.wrapper.getBoundingClientRect().height;
    if (height > 0) this.measuredHeights.set(mounted.id, height);
  }

  private mountBlock(node: BlockNode): MountedBlock {
    const { tag, className } = blockTag(node.type);
    const wrapper = h('div', 'be-block-wrapper');
    wrapper.dataset.blockId = node.id;
    const content = document.createElement(tag) as HTMLElement;
    content.className = className;
    content.dataset.blockId = node.id;
    this.applyBlockShell(content, node);

    wrapper.appendChild(content);
    const binding = new TextBinding(content, node);
    this.callbacks.onBindingCreated?.(binding);

    const mounted: MountedBlock = { id: node.id, wrapper, content, binding, height: ESTIMATED_BLOCK_HEIGHT };
    content.addEventListener('focus', () => {
      // 聚焦时上抛当前 caret；实际偏移由 TextBinding 的 selection 回调给出。
    });
    return mounted;
  }

  private updateBlockShell(mounted: MountedBlock, node: BlockNode): void {
    const { className } = blockTag(node.type);
    mounted.content.className = className;
    this.applyBlockShell(mounted.content, node);
  }

  /** 类型相关的外观属性（标题级别、代码语言、自定义块 class 钩子）。 */
  private applyBlockShell(content: HTMLElement, node: BlockNode): void {
    if (node.type === 'heading') content.dataset.level = String(headingLevel(node));
    if (node.type === 'code') content.dataset.language = String(node.getAttr('language') ?? '');
    const custom = this.callbacks.customBlockClass?.(node.type);
    if (custom) content.classList.add(custom);
  }
}

function firstTextNode(root: HTMLElement): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  return (walker.nextNode() as Text | null) ?? null;
}
