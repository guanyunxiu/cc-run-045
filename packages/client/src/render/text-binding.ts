import type { BlockNode } from '@blockeditor/core';
import type { InlineAttributes } from '@blockeditor/core';
import { domOffsetToModel, modelOffsetToDom, renderInline } from './dom.js';

/** 工具栏支持的行内格式。 */
export type MarkName = 'bold' | 'italic' | 'underline' | 'strike' | 'code';

/**
 * TextBinding —— 单个块行内文本的 contentEditable 绑定。
 *
 * 设计原则：
 *  - DOM 仅作为 Y.XmlText 的渲染投影，绝不在 DOM 层累积编辑状态；
 *  - 本地输入走 beforeinput（insertText / insertParagraph / deleteContent…），
 *    翻译为 Y.XmlText 事务，再由"远端/本地统一"的渲染路径回流；
 *  - Yjs observe 触发时做最小 DOM 替换（整块行内内容），并保持选区；
 *  - 其他客户端的输入不会抢占本端选区（仅当编辑同一块时才恢复）。
 */
export class TextBinding {
  /** 编辑回调：由 EditorSession 提供，负责块拆分 / 合并 / 普通文本写入。 */
  onEdit:
    | ((action:
        | { type: 'insert'; index: number; text: string }
        | { type: 'delete'; index: number; length: number }
        | { type: 'split'; index: number }
        | { type: 'merge' }
        | { type: 'format'; index: number; length: number; attrs: InlineAttributes }) => void)
    | null = null;

  /** 工具栏 / 快捷键切换行内格式（加粗、斜体…）；由会话层决定开关并走本地事务。 */
  onToggleMark: ((mark: MarkName) => void) | null = null;

  onSelectionChange: ((index: number | null) => void) | null = null;

  private destroyed = false;

  constructor(
    readonly content: HTMLElement,
    readonly node: BlockNode,
  ) {
    content.contentEditable = 'true';
    content.spellcheck = false;
    this.render();
    content.addEventListener('beforeinput', this.handleBeforeInput);
    content.addEventListener('input', this.handleInput as EventListener);
    content.addEventListener('keydown', this.handleKeydown);
    content.addEventListener('keyup', this.scheduleEmitSelection);
    content.addEventListener('mouseup', this.scheduleEmitSelection);
    this.node.text.observe(this.handleYTextChange);
  }

  destroy(): void {
    this.destroyed = true;
    this.content.removeEventListener('beforeinput', this.handleBeforeInput);
    this.content.removeEventListener('input', this.handleInput as EventListener);
    this.content.removeEventListener('keydown', this.handleKeydown);
    this.content.removeEventListener('keyup', this.scheduleEmitSelection);
    this.content.removeEventListener('mouseup', this.scheduleEmitSelection);
    this.node.text.unobserve(this.handleYTextChange);
  }

  /**
   * 当前选区在本块内的字符区间；选区折叠或不在本块时返回 null。
   * 返回的 from/to 已按方向归一化为 from <= to。
   */
  getSelectionRange(): { from: number; to: number } | null {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    if (!this.content.contains(sel.anchorNode) || !this.content.contains(sel.focusNode)) return null;
    const start = domOffsetToModel(this.content, sel.anchorNode!, sel.anchorOffset);
    const end = domOffsetToModel(this.content, sel.focusNode!, sel.focusOffset);
    const [from, to] = start <= end ? [start, end] : [end, start];
    return { from, to };
  }

  // -------------------------------------------------------------------------
  // Y.XmlText -> DOM
  // -------------------------------------------------------------------------

  render(): void {
    if (this.destroyed) return;
    const hadFocus = this.content.contains(document.activeElement) || this.content === document.activeElement;
    const saved = hadFocus ? this.saveSelection() : null;
    this.content.replaceChildren(renderInline(this.node.getDelta()));
    if (saved !== null) this.restoreSelection(saved);
  }

  private handleYTextChange = (): void => {
    // 无论本地还是远端事务，统一以 Yjs 数据为准重渲染该块行内容。
    this.render();
  };

  // -------------------------------------------------------------------------
  // 选区保持
  // -------------------------------------------------------------------------

  private saveSelection(): number | null {
    const sel = document.getSelection();
    const anchor = sel?.anchorNode;
    if (!sel || sel.rangeCount === 0 || !anchor || !this.content.contains(anchor)) return null;
    return domOffsetToModel(this.content, anchor, sel.anchorOffset);
  }

  private restoreSelection(index: number): void {
    const position = modelOffsetToDom(this.content, index);
    const range = document.createRange();
    range.setStart(position.node, position.offset);
    range.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private currentIndex(): number | null {
    const sel = document.getSelection();
    const anchor = sel?.anchorNode;
    if (!sel || sel.rangeCount === 0 || !anchor || !this.content.contains(anchor)) return null;
    return domOffsetToModel(this.content, anchor, sel.anchorOffset);
  }

  private scheduleEmitSelection = (): void => {
    this.onSelectionChange?.(this.currentIndex());
  };

  // -------------------------------------------------------------------------
  // DOM -> Y.XmlText（beforeinput 翻译）
  // -------------------------------------------------------------------------

  private handleBeforeInput = (event: InputEvent): void => {
    const index = this.currentIndex();
    if (index === null) return;
    event.preventDefault();

    switch (event.inputType) {
      case 'insertText':
        if (event.data) this.onEdit?.({ type: 'insert', index, text: event.data });
        break;
      case 'insertParagraph':
      case 'insertLineBreak':
        // Enter 统一走块拆分；Shift+Enter 在代码块内插换行。
        if (this.node.type === 'code' && event.inputType === 'insertLineBreak') {
          this.onEdit?.({ type: 'insert', index, text: '\n' });
        } else {
          this.onEdit?.({ type: 'split', index });
        }
        break;
      case 'deleteContentBackward':
        if (index === 0) {
          this.onEdit?.({ type: 'merge' });
        } else {
          this.onEdit?.({ type: 'delete', index: index - 1, length: 1 });
        }
        break;
      case 'deleteContentForward':
        this.onEdit?.({ type: 'delete', index, length: 1 });
        break;
      case 'deleteWordBackward': {
        const text = this.node.getPlainText().slice(0, index);
        const match = text.match(/\S*\s*$/);
        const len = match ? match[0].length : 1;
        this.onEdit?.({ type: 'delete', index: index - len, length: len });
        break;
      }
      case 'insertFromPaste':
        // 粘贴由块级 paste 处理器接管（见 EditorSurface），这里吞掉默认行为。
        break;
      default:
        // 未识别的输入不做默认 DOM 变更，避免 DOM 与模型漂移。
        break;
    }
  };

  private handleInput = (): void => {
    // beforeinput 已 preventDefault，正常不会触发；兜底再对齐一次。
    this.render();
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    // 粘贴（含全局块剪贴板）在 surface 层处理；此处仅拦截格式快捷键。
    // 与工具栏按钮走同一条会话层路径：本地事务、可同步、可撤销、可取消。
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      this.onToggleMark?.('bold');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.onToggleMark?.('italic');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      this.onToggleMark?.('underline');
    }
  };
}
