/**
 * 块文档模型内核 —— 公共类型定义。
 *
 * 模型概览（Yjs CRDT 结构，见 block-doc.ts）：
 *
 *   Y.Doc
 *   ├─ blocks: Y.Map<BlockId, YBlock>   所有块按 ID 随机访问
 *   └─ order:  Y.Array<BlockId>         块的规范线性顺序（移动即重排）
 *
 *   YBlock = Y.Map
 *   ├─ meta:  Y.Map   统一块元数据（id / type / 创建信息 / 更新时间）
 *   ├─ attrs: Y.Map   块级自定义属性（标题级别、代码语言、扩展块配置…）
 *   └─ text:  Y.XmlText 行内富文本（bold / italic / 链接等 Delta 格式）
 *
 * 当前为线性扁平结构；YBlock.meta.parentId 已预留，迭代 2 的表格等
 * 容器块可在不破坏 CRDT 结构的前提下扩展为树。
 */

/** 迭代 1 内置块类型；自定义块通过 BlockRegistry 注册。 */
export type BuiltinBlockType = 'paragraph' | 'heading' | 'quote' | 'code';

/** 行内格式属性（Delta insert 的 attributes）。值为 null 表示显式删除该属性（配合 Y.XmlText.format 取消格式）。 */
export interface InlineAttributes {
  bold?: boolean | null;
  italic?: boolean | null;
  underline?: boolean | null;
  strike?: boolean | null;
  code?: boolean | null;
  color?: string | null;
  background?: string | null;
  link?: string | null;
  /** 允许扩展自定义行内属性。 */
  [key: string]: unknown;
}

/** Y.XmlText.toDelta() 的单条操作。 */
export interface DeltaItem {
  insert?: string;
  delete?: number;
  retain?: number;
  attributes?: InlineAttributes;
}

/** 块级自定义属性。 */
export interface BlockAttributes {
  /** heading：1-6 级标题。 */
  level?: number;
  /** code：编程语言标记。 */
  language?: string;
  [key: string]: unknown;
}

/** 统一块元数据。 */
export interface BlockMeta {
  /** 块全局唯一 ID（复制粘贴产生新块时会重新分配）。 */
  id: string;
  /** 块类型标识，需在 BlockRegistry 中注册（内置类型已预置）。 */
  type: string;
  /** 父容器块 ID；当前线性模型恒为 null，预留给表格 / 嵌套块。 */
  parentId: string | null;
  /** 创建者用户 ID（由协同会话注入，离线时可为 null）。 */
  createdBy: string | null;
  /** 创建时间戳（毫秒）。 */
  createdAt: number;
  /** 最近本地事务更新时间戳。 */
  updatedAt: number;
}

export type BlockChangeType =
  | 'add' // 块被创建
  | 'delete' // 块被删除
  | 'update' // 块文本 / 属性变化
  | 'move'; // 块在 order 中的位置变化

export interface BlockChange {
  type: BlockChangeType;
  id: string;
}

/** observe 事件：一次 Yjs 事务对应一次 DocChangeEvent。 */
export interface DocChangeEvent {
  changes: BlockChange[];
  /** 原始事务，渲染层可据此做更精细的增量判断。 */
  transaction: unknown;
  /** 是否为本地事务（origin === LOCAL_ORIGIN）。 */
  local: boolean;
  /** 事务 origin：本地编辑、远端同步、撤销 / 重做各自不同。 */
  origin: unknown;
}

export type DocChangeHandler = (event: DocChangeEvent) => void;

export interface CreateBlockOptions {
  type: string;
  id?: string;
  /** 插入位置；默认追加到文档末尾。 */
  index?: number;
  attrs?: BlockAttributes;
  /** 初始行内内容（Delta 的 insert 片段，与剪贴板格式互通）。 */
  content?: DeltaItem[];
  parentId?: string | null;
}
