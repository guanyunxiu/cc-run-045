import type { BlockAttributes, BuiltinBlockType, InlineAttributes } from './types.js';

/**
 * 块扩展注册描述。迭代 2 的表格、图片等自定义块通过 registerBlock 接入，
 * 内核无需为具体块类型硬编码任何行为。
 */
export interface BlockDefinition {
  /** 块类型标识，全文档唯一。 */
  type: string;
  /** 人类可读名称（工具栏 / 块菜单使用）。 */
  label: string;
  /** 块级自定义属性的默认值与白名单。 */
  defaultAttrs?: BlockAttributes;
  /**
   * 该块允许出现的行内属性白名单；undefined 表示允许全部。
   * 例如 code 块可禁止 link / bold，保证纯代码语义。
   */
  allowedInlineAttrs?: Array<keyof InlineAttributes> | undefined;
  /** 是否为容器块（迭代 2 表格等）。当前渲染器按叶子块处理 false 情形。 */
  isContainer?: boolean;
  /** 粘贴 / 拆分时的降级目标：不认识该自定义块的旧客户端如何呈现。 */
  fallbackType?: string;
}

/**
 * 全局块注册表。内置四类块已预置；自定义块在创建 BlockDoc 前注册即可
 * 被粘贴合并 / 反序列化识别（未注册类型会降级为 paragraph，保证跨版本兼容）。
 */
export class BlockRegistry {
  private readonly definitions = new Map<string, BlockDefinition>();

  static createDefault(): BlockRegistry {
    const registry = new BlockRegistry();
    registry.register({ type: 'paragraph', label: '正文', fallbackType: 'paragraph' });
    registry.register({ type: 'heading', label: '标题', defaultAttrs: { level: 1 }, fallbackType: 'paragraph' });
    registry.register({ type: 'quote', label: '引用', fallbackType: 'paragraph' });
    registry.register({
      type: 'code',
      label: '代码块',
      defaultAttrs: { language: 'plaintext' },
      allowedInlineAttrs: ['code', 'color'],
      fallbackType: 'paragraph',
    });
    return registry;
  }

  register(definition: BlockDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`块类型 "${definition.type}" 已注册`);
    }
    this.definitions.set(definition.type, definition);
  }

  get(type: string): BlockDefinition | undefined {
    return this.definitions.get(type);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }

  /** 未注册类型统一降级为段落，保证旧客户端不丢数据。 */
  resolveType(type: string): BuiltinBlockType | string {
    if (this.definitions.has(type)) return type;
    const fallback = this.definitions.get(type)?.fallbackType;
    return fallback ?? 'paragraph';
  }

  defaultAttrs(type: string): BlockAttributes {
    return { ...(this.definitions.get(type)?.defaultAttrs ?? {}) };
  }
}
