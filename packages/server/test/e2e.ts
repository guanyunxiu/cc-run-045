// 端到端冒烟（无需浏览器）：
//   1. HTTP 演示登录拿 JWT；2. 建文档；
//   3. 两个 WebSocket 客户端接入同一房间，完成 sync step1/2 握手；
//   4. 客户端 A 发 SyncUpdate（本地新增一个块），客户端 B 应收到二进制增量；
//   5. 幂等 ref 重放，只合并一次，且收到 Ack；
//   6. awareness 更新（光标）互通。
//
// 运行：先启动服务端（npx tsx src/main.ts），再执行
//   npx tsx test/e2e.ts
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import {
  FrameKind,
  createSyncStep1Payload,
  encodeAwarenessUpdatePayload,
  encodeSyncUpdatePayload,
  packFrames,
  processSyncPayload,
  unpackFrames,
  type Frame,
} from '@blockeditor/proto';

const BASE_HTTP = 'http://localhost:3000/api';
const BASE_WS = 'ws://localhost:3000/collab/ws';

let authToken: string | null = null;

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE_HTTP}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class TestClient {
  ws: WebSocket | null = null;
  doc = new Y.Doc();
  clientId = Math.floor(Math.random() * 1e9);
  incoming: Frame[] = [];
  synced = false;
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  connect(docId: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${BASE_WS}?doc=${encodeURIComponent(docId)}&token=${encodeURIComponent(token)}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('error', reject);
      ws.on('message', (data) => {
        const frames = unpackFrames(new Uint8Array(data as ArrayBuffer));
        for (const frame of frames) this.dispatch(frame);
      });
    });
  }

  private dispatch(frame: Frame): void {
    this.incoming.push(frame);
    if (frame.kind === FrameKind.SyncStep1 || frame.kind === FrameKind.SyncStep2 || frame.kind === FrameKind.SyncUpdate) {
      const reply = processSyncPayload(frame.payload, this.doc, { remote: true });
      if (reply && frame.kind === FrameKind.SyncStep1) {
        this.send([{ kind: FrameKind.SyncStep2, docId: frame.docId, payload: reply, clientId: this.clientId }]);
      }
      if (frame.kind === FrameKind.SyncStep2 && !this.synced) {
        this.synced = true;
      }
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].match(frame)) {
        const [w] = this.waiters.splice(i, 1);
        w.resolve(frame);
      }
    }
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
    const found = this.incoming.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待帧超时')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  send(frames: Frame[]): void {
    this.ws!.send(packFrames(frames));
  }

  close(): void {
    this.ws?.close();
  }
}

let passed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`✖ ${message}`);
  passed += 1;
  console.log(`✔ ${message}`);
}

async function main(): Promise<void> {
  // 1) 登录 + 建文档
  const { token, user } = await postJson('/auth/dev-login', { name: `测试用户_${Date.now() % 100000}` });
  assert(token, '演示登录获取 JWT');
  authToken = token;
  const doc = await postJson('/docs', { title: 'E2E 文档' });
  assert(doc.id, '创建文档');
  console.log(`  文档 ID: ${doc.id}，用户: ${user.name}`);

  // 2) 两个客户端接入同一房间
  const alice = new TestClient();
  const bob = new TestClient();
  await alice.connect(doc.id, token);
  await bob.connect(doc.id, token);

  // 告知服务端各自 clientId（query token 模式下首帧同步携带）。
  alice.send([
    { kind: FrameKind.SyncStep1, docId: doc.id, clientId: alice.clientId, payload: createSyncStep1Payload(alice.doc) },
  ]);
  bob.send([
    { kind: FrameKind.SyncStep1, docId: doc.id, clientId: bob.clientId, payload: createSyncStep1Payload(bob.doc) },
  ]);
  await sleep(500);
  assert(alice.synced, 'Alice 完成 sync step1/2 握手');
  assert(bob.synced, 'Bob 完成 sync step1/2 握手');

  // 3) Alice 本地新增一个块，捕获本地增量并以 SyncUpdate 发送
  let localUpdate: Uint8Array | null = null;
  alice.doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === null) localUpdate = u; // 直接 ydoc 事务，origin=null 表示本地
  });
  const blocks = alice.doc.getMap('blockdoc:blocks');
  const order = alice.doc.getArray('blockdoc:order');
  alice.doc.transact(() => {
    const block = new Y.Map();
    const meta = new Y.Map();
    meta.set('id', 'e2e-block-1');
    meta.set('type', 'paragraph');
    meta.set('parentId', null);
    meta.set('createdBy', user.id);
    meta.set('createdAt', Date.now());
    meta.set('updatedAt', Date.now());
    const attrs = new Y.Map();
    const text = new Y.XmlText();
    text.insert(0, '协同编辑你好', {});
    block.set('meta', meta);
    block.set('attrs', attrs);
    block.set('text', text);
    blocks.set('e2e-block-1', block);
    order.push(['e2e-block-1']);
  }, null);

  // 4) Bob 应收到该 SyncUpdate 并合并
  const updateFrame: Frame = {
    kind: FrameKind.SyncUpdate,
    docId: doc.id,
    clientId: alice.clientId,
    payload: encodeSyncUpdatePayload(localUpdate!),
    ref: 'alice:1',
  };
  alice.send([updateFrame]);
  await bob.waitFor((f) => f.kind === FrameKind.SyncUpdate);
  await sleep(200);
  const bobBlocks = bob.doc.getMap('blockdoc:blocks');
  const bobBlock = bobBlocks.get('e2e-block-1') as Y.Map<unknown> | undefined;
  assert(bobBlock !== undefined, 'Bob 收到并合并了 Alice 的块新增');
  const bobText = bobBlock!.get('text') as Y.XmlText;
  assert(bobText.toString().includes('协同编辑你好'), 'Bob 侧块文本内容正确');

  // 5) 幂等：同样的 ref 重放，服务端不重复广播且回 Ack
  alice.send([updateFrame]);
  const ack = await alice.waitFor((f) => f.kind === FrameKind.Ack && new TextDecoder().decode(f.payload) === 'alice:1');
  assert(ack, '服务端对幂等 ref 返回 Ack');
  await sleep(200);
  assert(bob.doc.getArray('blockdoc:order').length === 1, '重复更新幂等，Bob 侧块数量仍为 1');

  // 6) awareness：Bob 广播光标，Alice 收到（clientID 取自 Y.Doc，编码前对齐）
  const { Awareness } = await import('y-protocols/awareness');
  bob.doc.clientID = bob.clientId;
  const awarenessB = new Awareness(bob.doc);
  awarenessB.setLocalStateField('user', { id: user.id, name: user.name, color: 'hsl(120 70% 45%)' });
  awarenessB.setLocalStateField('cursor', { blockId: 'e2e-block-1', index: 3 });
  const awarenessPayload = encodeAwarenessUpdatePayload(awarenessB, [bob.clientId]);
  bob.send([{ kind: FrameKind.AwarenessUpdate, docId: doc.id, clientId: bob.clientId, payload: awarenessPayload }]);
  const cursorFrame = await alice.waitFor((f) => f.kind === FrameKind.AwarenessUpdate);
  assert(cursorFrame.payload.length > 0, 'Alice 收到 Bob 的 awareness（光标）二进制增量');

  // 7) 服务端持久化：等防抖落盘后重新建房间验证状态恢复
  await sleep(1200);
  alice.close();
  bob.close();
  await sleep(500);
  const carol = new TestClient();
  await carol.connect(doc.id, token);
  carol.send([
    { kind: FrameKind.SyncStep1, docId: doc.id, clientId: carol.clientId, payload: createSyncStep1Payload(carol.doc) },
  ]);
  await sleep(800);
  assert(
    carol.doc.getMap('blockdoc:blocks').has('e2e-block-1'),
    '新连接从持久化状态恢复出房间内已存在的块',
  );
  carol.close();

  console.log(`\n全部 ${passed} 项端到端断言通过`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
