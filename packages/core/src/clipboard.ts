import * as Y from 'yjs';
import { BlockDoc } from './block-doc.js';
import type { BlockAttributes, BlockMeta, DeltaItem } from './types.js';

/**
 * 全局块复制粘贴。
 *
 * 剪贴板格式（application/x-blockeditor-blocks + 纯文本兜底）：
 * {
 *   "v": 1,
 *   "blocks": [{ meta, attrs, delta }, ...]   // 顺序即粘贴顺序
 * }
 *
 * 设计要点：
 *  - 只携带逻辑数据，不携带任何 DOM，天然跨标签页 / 跨文档 / 跨设备；
 *  - 粘贴时所有块重新分配 ID（避免与目标文档冲突），
 *    CRDT 层因此可与"他人在同一位置粘贴"无冲突自动合并；
 *  - 未注册的自定义块类型降级为段落，但原始 attrs 保留在
 *    unknownAttrs 中，待支持该块的客户端再次复制时可恢复（向前兼容）。
 */

export const CLIPBOARD_MIME = 'application/x-blockeditor-blocks';

export interface ClipboardBlock {
  meta: Pick<BlockMeta, 'type' | 'parentId'>;
  attrs: BlockAttributes;
  delta: DeltaItem[];
}

export interface ClipboardData {
  v: 1;
  blocks: ClipboardBlock[];
}

function serializeBlocks(doc: BlockDoc, ids: string[]): ClipboardData {
  const present = new Set(doc.getIds());
  const blocks: ClipboardBlock[] = [];
  for (const id of ids) {
    if (!present.has(id)) continue;
    const node = doc.getBlock(id);
    if (!node) continue;
    blocks.push({
      meta: { type: node.type, parentId: node.parentId },
      attrs: node.getAttrs(),
      delta: node.getDelta(),
    });
  }
  return { v: 1, blocks };
}

/** 复制给定块（默认按文档规范顺序）。 */
export function copyBlocks(doc: BlockDoc, ids: string[]): ClipboardData {
  const order = doc.getIds();
  const selected = new Set(ids);
  return serializeBlocks(
    doc,
    order.filter((id) => selected.has(id)),
  );
}

/** 复制整篇文档。 */
export function copyAll(doc: BlockDoc): ClipboardData {
  return serializeBlocks(doc, doc.getIds());
}

/** 剪贴板数据 -> DataTransfer（挂到原生 copy / 程序化 clipboard.write）。 */
export function toDataTransfer(data: ClipboardData): { mime: string; json: string; text: string } {
  const text = data.blocks
    .map((b) =>
      b.delta
        .map((d) => d.insert ?? '')
        .join(''),
    )
    .join('\n');
  return { mime: CLIPBOARD_MIME, json: JSON.stringify(data), text };
}

export function parseClipboard(json: string): ClipboardData | null {
  try {
    const data = JSON.parse(json) as ClipboardData;
    if (data.v !== 1 || !Array.isArray(data.blocks)) return null;
    return data;
  } catch {
    return null;
  }
}

export interface PasteResult {
  /** 新粘贴块在文档中的 ID（粘贴顺序）。 */
  ids: string[];
  /** 光标建议落点：最后一个新块末尾。 */
  caret: { blockId: string; index: number } | null;
}

/**
 * 将剪贴板块粘贴到 atIndex 位置。整段操作落在同一个 Yjs 事务里：
 * 对协同端而言是一次原子的二进制增量。
 */
export function pasteBlocks(doc: BlockDoc, data: ClipboardData, atIndex?: number): PasteResult {
  const ids: string[] = [];
  doc.transactLocal(() => {
    const base = atIndex ?? doc.length;
    data.blocks.forEach((block, offset) => {
      const id = doc.createBlock({
        type: block.meta.type,
        index: base + offset,
        attrs: block.attrs,
        content: block.delta,
      });
      ids.push(id);
    });
  });
  const lastId = ids[ids.length - 1];
  const lastNode = lastId ? doc.getBlock(lastId) : null;
  return {
    ids,
    caret: lastId && lastNode ? { blockId: lastId, index: lastNode.text.length } : null,
  };
}

/** 纯文本粘贴：按换行拆成多个段落块。 */
export function pastePlainText(doc: BlockDoc, text: string, atIndex?: number): PasteResult {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return pasteBlocks(
    doc,
    {
      v: 1,
      blocks: lines.map((line) => ({
        meta: { type: 'paragraph', parentId: null },
        attrs: {},
        delta: line ? [{ insert: line }] : [],
      })),
    },
    atIndex,
  );
}

/** 跨 Yjs 文档深拷贝（迁移 / 另存为；ID 保持不变，仅同库内使用）。 */
export function cloneYjsUpdate(update: Uint8Array): Uint8Array {
  // Yjs 状态更新是不可变的结构化数据；复制底层字节即可安全持有。
  const clone = new Uint8Array(update.length);
  clone.set(update);
  return clone;
}
