import type { Awareness } from 'y-protocols/awareness';
import type { AwarenessState } from '../collab/awareness-state.js';
import { colorWithAlpha } from '../collab/awareness-state.js';
import { h, modelOffsetToDom } from './dom.js';
import type { BlockRenderer } from './block-renderer.js';

interface CursorDom {
  flag: HTMLElement;
  /** 选区高亮（折叠光标时不存在）。 */
  selection: HTMLElement | null;
}

/**
 * RemoteCursorLayer —— 其他用户光标 / 选区的覆盖层。
 *
 * 数据来自 y-protocols Awareness（二进制增量广播）：
 *  { clientID -> { user, cursor: {blockId, index, anchor?} } }
 *
 * 覆盖层与滚动容器同尺寸、pointer-events:none，光标位置根据
 * 块内容 DOM 的字符偏移实时测量，滚动 / 块高度变化时跟随重定位。
 * 用户未挂载的虚拟块跳过渲染（其滚回视口时经 awareness 重放补齐）。
 */
export class RemoteCursorLayer {
  private readonly layer: HTMLElement;
  private readonly cursorEls = new Map<number, CursorDom>();
  private detachAwareness: (() => void) | null = null;
  private rafScheduled = false;

  constructor(
    private readonly awareness: Awareness,
    private readonly renderer: BlockRenderer,
    container: HTMLElement,
  ) {
    this.layer = h('div', 'be-cursor-layer');
    container.appendChild(this.layer);
    this.awareness.on('change', this.scheduleUpdate);
    this.detachAwareness = () => this.awareness.off('change', this.scheduleUpdate);
    renderer.scrollRoot.addEventListener('scroll', this.scheduleUpdate, { passive: true });
    this.update();
  }

  destroy(): void {
    this.detachAwareness?.();
    this.renderer.scrollRoot.removeEventListener('scroll', this.scheduleUpdate);
    this.layer.remove();
  }

  private scheduleUpdate = (): void => {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.update();
    });
  };

  private states(): Array<{ clientId: number; state: AwarenessState }> {
    const result: Array<{ clientId: number; state: AwarenessState }> = [];
    this.awareness.getStates().forEach((raw, clientId) => {
      if (clientId === this.awareness.clientID) return;
      const state = raw as Partial<AwarenessState>;
      if (state.user && state.cursor) result.push({ clientId, state: state as AwarenessState });
    });
    return result;
  }

  private update(): void {
    const live = new Set<number>();
    const scrollRect = this.renderer.scrollRoot.getBoundingClientRect();

    for (const { clientId, state } of this.states()) {
      live.add(clientId);
      const cursor = state.cursor!;
      const binding = this.renderer.getBinding(cursor.blockId);
      if (!binding) {
        this.cursorEls.get(clientId)?.flag.style.setProperty('display', 'none');
        continue;
      }
      const contentRect = binding.content.getBoundingClientRect();
      const { node, offset } = modelOffsetToDom(binding.content, cursor.index);
      const point = measurePoint(binding.content, node, offset);
      if (!point) continue;

      let els = this.cursorEls.get(clientId);
      if (!els) {
        els = this.createCursor(state);
        this.cursorEls.set(clientId, els);
      }
      els.flag.style.removeProperty('display');
      const x = contentRect.left - scrollRect.left + point.x;
      const y = contentRect.top - scrollRect.top + this.renderer.scrollRoot.scrollTop + point.y;
      els.flag.style.transform = `translate(${x}px, ${y}px)`;
      (els.flag.querySelector('.be-cursor-name') as HTMLElement).textContent = state.user.name;
      els.flag.style.setProperty('--cursor-color', state.user.color);

      // 非折叠选区：从 anchor 到 caret 绘制高亮条。
      if (cursor.anchor && cursor.anchor.blockId === cursor.blockId) {
        this.paintSelection(els, binding, state, cursor.anchor.index, cursor.index, scrollRect);
      } else if (els.selection) {
        els.selection.style.display = 'none';
      }
    }

    for (const [clientId, els] of this.cursorEls) {
      if (!live.has(clientId)) {
        els.flag.remove();
        els.selection?.remove();
        this.cursorEls.delete(clientId);
      }
    }
  }

  private createCursor(state: AwarenessState): CursorDom {
    const flag = h('div', 'be-remote-cursor');
    const bar = h('span', 'be-cursor-bar');
    const name = h('span', 'be-cursor-name');
    name.textContent = state.user.name;
    flag.append(bar, name);
    this.layer.appendChild(flag);
    return { flag, selection: null };
  }

  private paintSelection(
    els: CursorDom,
    binding: { content: HTMLElement },
    state: AwarenessState,
    from: number,
    to: number,
    scrollRect: DOMRect,
  ): void {
    const [a, b] = from <= to ? [from, to] : [to, from];
    if (b - a === 0) {
      els.selection && (els.selection.style.display = 'none');
      return;
    }
    // 用 Range.getClientRects 取选区真实矩形（自动跨行）。
    const start = modelOffsetToDom(binding.content, a);
    const end = modelOffsetToDom(binding.content, b);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rects = [...range.getClientRects()];

    let sel = els.selection;
    if (!sel) {
      sel = h('div', 'be-remote-selection');
      this.layer.appendChild(sel);
      els.selection = sel;
    }
    sel.style.removeProperty('display');
    sel.style.background = colorWithAlpha(state.user.color, 0.18);
    // 以一个大盒 + 多个子矩形表达跨行选区。
    sel.replaceChildren(
      ...rects.map((rect) => {
        const box = h('div', 'be-remote-selection-rect');
        box.style.left = `${rect.left - scrollRect.left}px`;
        box.style.top = `${rect.top - scrollRect.top + this.renderer.scrollRoot.scrollTop}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        return box;
      }),
    );
  }
}

/** 测量块内 (node, offset) 相对 content 容器顶部/左侧的坐标。 */
function measurePoint(content: HTMLElement, node: Node, offset: number): { x: number; y: number } | null {
  const range = document.createRange();
  try {
    range.setStart(node, offset);
  } catch {
    range.selectNodeContents(content);
    range.collapse(false);
  }
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  return { x: rect.left - contentRect.left, y: rect.top - contentRect.top };
}
