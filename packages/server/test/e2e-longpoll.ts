// 长轮询端到端冒烟（无需浏览器）：
// 1. 两个长轮询客户端先后打开同一篇全新文档，各自只在"首轮同步后本地仍为空"时插入起始段落
//    -> 最终服务端房间只能有 1 个段落；
// 2. A 在段落里打字（LOCAL_ORIGIN 事务）-> B 经长轮询收到；
// 3. A 对选区加粗（BlockDoc.formatText，本地事务）-> B 看到 bold；
// 4. A 撤销加粗（UndoManager origin 事务）-> B 侧 bold 消失。
import * as Y from 'yjs';
import {
  BlockDoc,
  LOCAL_ORIGIN,
} from '@blockeditor/core';
import {
  FrameKind,
  createSyncStep1Payload,
  encodeSyncUpdatePayload,
  packFrames,
  processSyncPayload,
  unpackFrames,
  type Frame,
} from '@blockeditor/proto';

const BASE = 'http://localhost:5191/api';
const POLL = 'http://localhost:5191/api/collab/poll';

let authToken: string | null = null;

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class PollClient {
  readonly blockDoc: BlockDoc;
  private readonly doc: Y.Doc;
  private outbound: Frame[] = [];
  private stopped = false;
  private polling = false;
  private currentController: AbortController | null = null;
  synced = false;
  onInitialSync: (() => void) | null = null;
  private clientId: number;
  private readonly name0: string;

  constructor(
    private readonly token: string,
    private readonly docId: string,
    name: string,
  ) {
    this.name0 = name;
    this.doc = new Y.Doc();
    this.clientId = Math.floor(Math.random() * 1e9) + 1;
    this.blockDoc = new BlockDoc(this.doc, { userId: name });
    // 与客户端 NetworkManager 相同的本地 origin 判定（含 UndoManager 实例）。
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL_ORIGIN || origin === this.blockDoc.undoManager) {
        this.send([
          {
            kind: FrameKind.SyncUpdate,
            docId,
            clientId: this.clientId,
            payload: encodeSyncUpdatePayload(update),
            ref: `${this.clientId}:${Math.random()}`,
          },
        ]);
      }
    });
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.currentController?.abort();
  }

  send(frames: Frame[]): void {
    this.outbound.push(...frames);
    if (!this.stopped) {
      if (!this.polling) void this.loop();
      else this.currentController?.abort(); // 内容帧立即续发，不等 25s 心跳
    }
  }

  private handshakeSent = false;
  private async loop(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    while (!this.stopped) {
      const frames = this.outbound;
      this.outbound = [];
      // 首次 poll 必带 Auth + SyncStep1（与浏览器端 NetworkManager.handshake 一致）。
      if (!this.handshakeSent) {
        this.handshakeSent = true;
        frames.unshift(
          {
            kind: FrameKind.Auth,
            docId: this.docId,
            clientId: this.clientId,
            payload: new TextEncoder().encode(this.token),
          },
          {
            kind: FrameKind.SyncStep1,
            docId: this.docId,
            clientId: this.clientId,
            payload: createSyncStep1Payload(this.doc),
          },
        );
      }
      if (process.env.POLL_DEBUG)
        console.log(this.name0, 'POST frames =', frames.map((f) => FrameKind[f.kind]).join(','));
      const controller = new AbortController();
      this.currentController = controller;
      const timer = setTimeout(() => controller.abort(), 30_000);
      let bytes: Uint8Array;
      try {
        const res = await fetch(`${POLL}/${encodeURIComponent(this.docId)}?clientId=${this.clientId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-protobuf',
            Authorization: `Bearer ${this.token}`,
          },
          body: packFrames(frames).buffer as ArrayBuffer,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`poll ${res.status}`);
        bytes = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        clearTimeout(timer);
        // 为捎带新帧主动中断：立即续发。
        if (!this.stopped && controller.signal.aborted) continue;
        console.error('poll error', err);
        await sleep(1000);
        continue;
      }
      const received = unpackFrames(bytes);
      if (process.env.POLL_DEBUG)
        console.log(this.name0, 'RESP frames =', received.map((f) => FrameKind[f.kind]).join(','));
      for (const frame of received) {
        this.handle(frame);
      }
    }
    this.polling = false;
  }

  private handle(frame: Frame): void {
    if (
      frame.kind === FrameKind.SyncStep1 ||
      frame.kind === FrameKind.SyncStep2 ||
      frame.kind === FrameKind.SyncUpdate
    ) {
      const reply = processSyncPayload(frame.payload, this.doc, Symbol('remote'));
      if (reply && frame.kind === FrameKind.SyncStep1) {
        this.send([{ kind: FrameKind.SyncStep2, docId: this.docId, payload: reply, clientId: this.clientId }]);
      }
      if (frame.kind === FrameKind.SyncStep2 && !this.synced) {
        this.synced = true;
        this.onInitialSync?.();
      }
    }
  }
}

let passed = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`✖ ${msg}`);
  passed += 1;
  console.log(`✔ ${msg}`);
}

async function main(): Promise<void> {
  const { token } = await postJson('/auth/dev-login', { name: `poll_${Date.now() % 100000}` });
  authToken = token;
  const doc = await postJson('/docs', { title: '长轮询新文档' });
  console.log(`  文档 ID: ${doc.id}`);

  const a = new PollClient(token, doc.id, 'alice');
  const b = new PollClient(token, doc.id, 'bob');

  // 复刻浏览器端修复后的 seeding 规则：首轮同步后本地为空才插，且只插一次。
  for (const c of [a, b]) {
    let seeded = false;
    c.onInitialSync = () => {
      if (!seeded) {
        seeded = true;
        if (c.blockDoc.length === 0) c.blockDoc.createBlock({ type: 'paragraph' });
      }
    };
  }

  a.start();
  await sleep(1500); // 等 A 完成握手 + 起始段落广播
  b.start();
  await sleep(2500); // B 后打开，收到 A 的段落后不应再插

  assert(a.synced && b.synced, '两个长轮询客户端都完成首轮同步');
  assert(a.blockDoc.length === 1, `A 侧只有 1 个块（实际 ${a.blockDoc.length}）`);
  assert(b.blockDoc.length === 1, `B 侧只有 1 个块，没有重复起始段落（实际 ${b.blockDoc.length}）`);
  assert(a.blockDoc.getIds()[0] === b.blockDoc.getIds()[0], '两侧段落是同一个 CRDT 块 ID');

  // A 打字 -> B 收到
  const blockId = a.blockDoc.getIds()[0];
  a.blockDoc.insertText(blockId, 0, 'hello format');
  await sleep(1500);
  assert(
    b.blockDoc.getBlock(blockId)?.getPlainText() === 'hello format',
    'A 的打字经长轮询同步到 B',
  );

  // A 对 [0,5) 加粗 -> B 看到 bold（本地事务链路）
  a.blockDoc.formatText(blockId, 0, 5, { bold: true });
  await sleep(1500);
  const bDelta = b.blockDoc.getBlock(blockId)?.getDelta();
  assert(
    bDelta?.[0]?.attributes?.bold === true && bDelta[0].insert === 'hello',
    'A 工具栏加粗（本地事务）同步到 B，且只覆盖目标区间',
  );

  // 同区间再加斜体，bold 不应被冲掉
  a.blockDoc.formatText(blockId, 0, 5, { italic: true });
  await sleep(1500);
  const d2 = b.blockDoc.getBlock(blockId)?.getDelta();
  assert(d2?.[0]?.attributes?.bold === true && d2?.[0]?.attributes?.italic === true, '加粗与斜体可共存');

  // 取消加粗
  a.blockDoc.formatText(blockId, 0, 5, { bold: null });
  await sleep(1500);
  const d3 = b.blockDoc.getBlock(blockId)?.getDelta();
  assert(d3?.[0]?.attributes?.bold == null && d3?.[0]?.attributes?.italic === true, '再点一次可取消加粗，斜体保留');

  // 撤销：撤掉"取消加粗"，bold 应回来，且同步到 B（UndoManager origin 也广播）
  a.blockDoc.undo();
  await sleep(1500);
  const d4 = b.blockDoc.getBlock(blockId)?.getDelta();
  assert(d4?.[0]?.attributes?.bold === true, 'A 撤销后 B 侧 bold 恢复（撤销可同步）');
  // 再撤三次：斜体、加粗、打字全部回退
  a.blockDoc.undo();
  a.blockDoc.undo();
  a.blockDoc.undo();
  await sleep(1500);
  const plain = b.blockDoc.getBlock(blockId)?.getPlainText();
  assert(plain === '', '连续撤销（格式/打字）全部同步到 B');

  a.stop();
  b.stop();
  console.log(`\n全部 ${passed} 项长轮询断言通过`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
