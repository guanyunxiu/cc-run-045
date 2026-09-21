/**
 * 最小 protobuf wire-format 编解码器（零三方依赖）。
 *
 * 仅实现 Frame 协议所需的 varint / length-delimited 两类字段，
 * 编码结果与 protoc 生成的标准 proto3 二进制完全一致，
 * 可随时无缝替换为 protobufjs / 服务端其他语言的 protobuf 实现。
 *
 * Wire types: 0 = varint, 2 = length-delimited。
 */

/** 拼接多个 Uint8Array，避免逐个字节 push 造成的 O(n²)。 */
export function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const c of chunks) length += c.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class Writer {
  private chunks: number[] = [];

  private varint(value: number): void {
    let v = value >>> 0;
    while (v >= 0x80) {
      this.chunks.push((v & 0x7f) | 0x80);
      v = v >>> 7;
    }
    this.chunks.push(v & 0x7f);
  }

  private tag(fieldNumber: number, wireType: number): void {
    this.varint((fieldNumber << 3) | wireType);
  }

  /** proto3 标量默认值（0）无需编码，调用方应先判断。 */
  writeUint32(fieldNumber: number, value: number): this {
    if (value === 0) return this;
    this.tag(fieldNumber, 0);
    this.varint(value >>> 0);
    return this;
  }

  writeString(fieldNumber: number, value: string): this {
    if (value.length === 0) return this;
    return this.writeBytes(fieldNumber, textEncoder.encode(value));
  }

  writeBytes(fieldNumber: number, value: Uint8Array): this {
    if (!value || value.length === 0) return this;
    this.tag(fieldNumber, 2);
    this.varint(value.length);
    // 逐字节拷贝到统一缓冲；payload 数量很少，可接受。
    for (let i = 0; i < value.length; i++) this.chunks.push(value[i]);
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export interface RawFields {
  /** fieldNumber -> 多次出现的值列表（proto3 无 packed，本协议亦无重复字段）。 */
  [fieldNumber: number]: Array<number | string | Uint8Array>;
}

/** 将一个标准 protobuf 消息解码为 fieldNumber -> value 列表。 */
export function decodeMessage(bytes: Uint8Array): RawFields {
  const fields: RawFields = {};
  let offset = 0;

  const readVarint = (): number => {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = bytes[offset++];
      if (byte === undefined) throw new Error('protobuf: 意外的消息结尾');
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80 && shift < 32);
    return result >>> 0;
  };

  while (offset < bytes.length) {
    const tag = readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    let value: number | string | Uint8Array;
    if (wireType === 0) {
      value = readVarint();
    } else if (wireType === 2) {
      const len = readVarint();
      value = bytes.subarray(offset, offset + len);
      offset += len;
    } else {
      throw new Error(`protobuf: 不支持的 wire type ${wireType}`);
    }
    (fields[fieldNumber] ??= []).push(value);
  }
  return fields;
}

export function asUint8Array(value: number | string | Uint8Array | undefined): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value === undefined) return new Uint8Array(0);
  return textEncoder.encode(String(value));
}

export function asString(value: number | string | Uint8Array | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return textDecoder.decode(value);
}

export function asUint32(value: number | string | Uint8Array | undefined): number {
  return typeof value === 'number' ? value >>> 0 : 0;
}
