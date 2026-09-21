import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { Awareness } from 'y-protocols/awareness';
import { Writer, decodeMessage, asUint8Array, asString, asUint32, concat } from './wire.js';

/**
 * 协议帧类型。数值与 blockeditor.proto 中的 Frame.Kind 一一对应。
 */
export enum FrameKind {
  Unspecified = 0,
  SyncStep1 = 1,
  SyncStep2 = 2,
  SyncUpdate = 3,
  AwarenessUpdate = 4,
  AwarenessQuery = 5,
  Auth = 6,
  Ack = 7,
  Ping = 8,
  Pong = 9,
  Error = 10,
}

export interface Frame {
  kind: FrameKind;
  docId: string;
  /** 二进制载荷：y-protocols 消息 / JWT / ErrorPayload 等。 */
  payload: Uint8Array;
  clientId?: number;
  /**
   * 幂等引用键（可选）。客户端在 SyncUpdate 上携带（如 "clientID:seq"），
   * 服务端合并成功后以 Ack 帧原样回填，供离线队列确认出队；
   * 重连重放时同 ref 的更新在服务端去重。
   */
  ref?: string;
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** 将单个帧编码为 protobuf 二进制。 */
export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.kind === FrameKind.Unspecified) throw new Error('Frame.kind 不能为空');
  const writer = new Writer();
  writer.writeUint32(1, frame.kind);
  writer.writeString(2, frame.docId);
  writer.writeBytes(3, frame.payload ?? new Uint8Array(0));
  if (frame.clientId !== undefined) writer.writeUint32(4, frame.clientId);
  if (frame.ref !== undefined) writer.writeString(5, frame.ref);
  return writer.finish();
}

/** 解码单个 protobuf 帧。 */
export function decodeFrame(bytes: Uint8Array): Frame {
  const fields = decodeMessage(bytes);
  return {
    kind: asUint32(fields[1]?.[0]) as FrameKind,
    docId: asString(fields[2]?.[0]),
    payload: asUint8Array(fields[3]?.[0]),
    clientId: fields[4] !== undefined ? asUint32(fields[4][0]) : undefined,
    ref: fields[5] !== undefined ? asString(fields[5][0]) : undefined,
  };
}

/**
 * length-delimited 打包：[uint32 BE len][frame]...
 * WebSocket 与长轮询响应均使用该物理封套，天然支持一帧多条消息。
 */
export function packFrames(frames: Frame[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const frame of frames.map(encodeFrame)) {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, frame.length, false);
    chunks.push(header, frame);
  }
  return concat(chunks);
}

export function packFrame(frame: Frame): Uint8Array {
  return packFrames([frame]);
}

/** 从一段（可能包含多帧的）二进制中拆出全部帧。 */
export function unpackFrames(bytes: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
    offset += 4;
    if (offset + len > bytes.length) {
      throw new Error(`帧长度 ${len} 超出剩余字节 ${bytes.length - offset}`);
    }
    frames.push(decodeFrame(bytes.subarray(offset, offset + len)));
    offset += len;
  }
  if (offset !== bytes.length) throw new Error('物理消息存在残余字节，帧边界损坏');
  return frames;
}

// ---------------------------------------------------------------------------
// y-protocols sync 载荷助手
//
// payload 字段承载的是 y-protocols 的 sync 消息（内部首字节为子消息类型）：
//   0 = SyncStep1(stateVector) / 1 = SyncStep2(update) / 2 = Update(update)
// 我们的 FrameKind 与之一一对应，构造 / 解析时复用官方实现，
// 保证与任意标准 y-websocket 服务端在 sync 语义层互通。
// ---------------------------------------------------------------------------

/** 构造 SyncStep1 载荷（y-protocols writeSyncStep1 已含消息类型字节）。 */
export function createSyncStep1Payload(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/**
 * 处理对端发来的 sync 载荷，返回需要回送的载荷（仅收到 step1 时产生 step2），
 * 否则返回 null。step2 / update 会在此函数内幂等地 apply 到本地文档。
 *
 * @param origin Yjs 事务 origin，标记远端来源（如 { wsclient: id }），
 *               服务端据此在广播时排除发送者；本地 origin 由各端自定义。
 */
export function processSyncPayload(payload: Uint8Array, doc: Y.Doc, origin?: unknown): Uint8Array | null {
  const decoder = decoding.createDecoder(payload);
  const encoder = encoding.createEncoder();
  sync.readSyncMessage(decoder, encoder, doc, origin ?? null);
  // 仅 step1 会令 encoder 写入 step2 响应（至少含 1 字节消息类型）。
  return encoding.length(encoder) > 0 ? encoding.toUint8Array(encoder) : null;
}

/**
 * 将一次 Yjs 事务产生的增量更新包装为 SyncUpdate 载荷
 * （y-protocols writeUpdate 内部已写 messageYjsUpdate 类型字节）。
 */
export function encodeSyncUpdatePayload(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

// ---------------------------------------------------------------------------
// awareness 载荷助手（光标 / 选区 / 用户信息）
// ---------------------------------------------------------------------------

/** 与 y-websocket 一致：直接编码 awareness 增量（内部含 client 状态 diff）。 */
export function encodeAwarenessUpdatePayload(awareness: Awareness, clientIds: number[]): Uint8Array {
  return awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds);
}

/** applyAwarenessUpdate 同时接受编码字节与解码对象（与 y-websocket 用法一致）。 */
export function applyAwarenessUpdatePayload(
  payload: Uint8Array,
  awareness: Awareness,
  origin: unknown = null,
): void {
  awarenessProtocol.applyAwarenessUpdate(awareness, payload, origin);
}

// ---------------------------------------------------------------------------
// Error 载荷（同样为 protobuf 编码的 ErrorPayload）
// ---------------------------------------------------------------------------

export function encodeErrorPayload(code: number, message: string): Uint8Array {
  return new Writer().writeUint32(1, code).writeString(2, message).finish();
}

export function decodeErrorPayload(payload: Uint8Array): { code: number; message: string } {
  const fields = decodeMessage(payload);
  return { code: asUint32(fields[1]?.[0]), message: asString(fields[2]?.[0]) };
}
