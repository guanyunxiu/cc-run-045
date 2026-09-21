import type { BlockNode } from '@blockeditor/core';
import type { DeltaItem, InlineAttributes } from '@blockeditor/core';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

/** 块类型 -> 渲染标签 / CSS 类。自定义块通过 setCustomRenderer 扩展。 */
export function blockTag(type: string): { tag: keyof HTMLElementTagNameMap; className: string } {
  switch (type) {
    case 'heading':
      return { tag: 'div', className: 'be-block be-heading' };
    case 'quote':
      return { tag: 'blockquote', className: 'be-block be-quote' };
    case 'code':
      return { tag: 'pre', className: 'be-block be-code' };
    default:
      return { tag: 'p', className: 'be-block be-paragraph' };
  }
}

/**
 * 将一条 Delta（行内富文本）渲染为 DOM 片段：
 * bold/italic/underline/strike/code/color/background/link。
 * 纯文本节点 + 最小标记元素，不使用 contentEditable 富文本框架的默认 DOM。
 */
export function renderInline(delta: DeltaItem[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue;
    const parts = op.insert.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) fragment.appendChild(document.createElement('br'));
      if (part.length) fragment.appendChild(applyMarks(document.createTextNode(part), op.attributes ?? {}));
    });
  }
  return fragment;
}

function applyMarks(textNode: Text, attrs: InlineAttributes): Node {
  let node: Node = textNode;
  const mark = (tag: string): HTMLElement => document.createElement(tag);

  if (attrs.code) {
    const el = mark('code');
    el.className = 'be-inline-code';
    el.appendChild(node);
    node = el;
  }
  if (attrs.bold) {
    const el = mark('strong');
    el.appendChild(node);
    node = el;
  }
  if (attrs.italic) {
    const el = mark('em');
    el.appendChild(node);
    node = el;
  }
  if (attrs.underline) {
    const el = mark('u');
    el.appendChild(node);
    node = el;
  }
  if (attrs.strike) {
    const el = mark('s');
    el.appendChild(node);
    node = el;
  }
  if (attrs.color && node instanceof HTMLElement) {
    node.style.color = String(attrs.color);
  } else if (attrs.color) {
    const el = mark('span');
    el.style.color = String(attrs.color);
    el.appendChild(node);
    node = el;
  }
  if (attrs.background) {
    const el = node instanceof HTMLElement ? node : mark('span');
    if (el !== node) el.appendChild(node);
    el.style.backgroundColor = String(attrs.background);
    node = el;
  }
  if (attrs.link) {
    const a = mark('a');
    a.setAttribute('href', String(attrs.link));
    a.className = 'be-link';
    a.appendChild(node);
    node = a;
  }
  return node;
}

/** 取块的标题级别（heading 用）。 */
export function headingLevel(node: BlockNode): number {
  const level = node.getAttr('level');
  return typeof level === 'number' ? level : 1;
}

/** 把 DOM 内的原生 Range 端点转换为"块内字符偏移"。 */
export function domOffsetToModel(content: HTMLElement, domNode: Node, domOffset: number): number {
  const range = document.createRange();
  range.selectNodeContents(content);
  range.setEnd(domNode, domOffset);
  return range.toString().length;
}

/** 将"块内字符偏移"映射回 DOM 内可放置光标的 (node, offset)。 */
export function modelOffsetToDom(content: HTMLElement, modelIndex: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, null);
  let remaining = modelIndex;
  let textNode = walker.nextNode() as Text | null;
  if (!textNode) return { node: content, offset: 0 };
  while (textNode) {
    const len = textNode.data.length;
    if (remaining <= len) return { node: textNode, offset: remaining };
    remaining -= len;
    textNode = walker.nextNode() as Text | null;
  }
  const last = content.lastChild;
  return { node: content, offset: last ? content.childNodes.length : 0 };
}
