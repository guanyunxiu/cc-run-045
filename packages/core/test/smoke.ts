// 内核冒烟测试：CRDT 合并、撤销、剪贴板、拆分/合并、增量幂等。
// 运行：npx tsx packages/core/test/smoke.ts
import * as Y from 'yjs';
import {
  BlockDoc,
  LOCAL_ORIGIN,
  REMOTE_ORIGIN,
  copyAll,
  pasteBlocks,
  parseClipboard,
  toDataTransfer,
} from '../src/index.js';

let passed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`✖ ${message}`);
  passed += 1;
  console.log(`✔ ${message}`);
}

// 1) 基础 CRUD
const docA = new Y.Doc();
const a = new BlockDoc(docA, { userId: 'u1' });
const p1 = a.createBlock({ type: 'paragraph', content: [{ insert: '你好' }] });
const h1 = a.createBlock({ type: 'heading', attrs: { level: 2 }, index: 0 });
assert(a.length === 2, '创建两个块后长度为 2');
assert(a.indexOf(h1) === 0, '标题块按 index 插入到首位');
assert(a.getBlock(p1)?.getPlainText() === '你好', '段落文本内容正确');

// 2) 监听变更事件
const seen: string[] = [];
a.on((event) => seen.push(...event.changes.map((c) => `${c.type}:${c.id.slice(0, 4)}`)));
a.insertText(p1, 2, '，世界', { bold: true });
assert(seen.some((s) => s.startsWith('update:')), '文本编辑产生 update 事件');

// 3) 移动
a.moveBlock(p1, 0);
assert(a.getIds()[0] === p1, 'moveBlock 后段落移动到首位');

// 4) 拆分 + 合并
const split = a.splitBlock(p1, 2);
assert(a.length === 3, '拆分块后长度为 3');
assert(a.getBlock(split.newId)?.getPlainText() === '，世界', '拆分尾部文本携带行内内容');
a.mergeWithPrevious(split.newId);
assert(a.length === 2, '与上一块合并后长度恢复为 2');
assert(a.getBlock(p1)?.getPlainText() === '你好，世界', '合并后文本完整');

// 5) 撤销重做（统一栈）
const before = a.length;
const tmp = a.createBlock({ type: 'paragraph' });
assert(a.length === before + 1, '新增临时块');
a.undo();
assert(a.length === before && a.getBlock(tmp) === null, 'undo 撤销新增块');
a.redo();
assert(a.length === before + 1, 'redo 恢复新增块');
a.undo();

// 6) 远端并发合并：先同步基线，再离线分叉、交叉传播增量
const docB = new Y.Doc();
const b = new BlockDoc(docB, { userId: 'u2' });
Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA), REMOTE_ORIGIN);
Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB), REMOTE_ORIGIN);

let updateFromB: Uint8Array | null = null;
docB.on('update', (u: Uint8Array, origin: unknown) => {
  if (origin === LOCAL_ORIGIN) updateFromB = u;
});
const bBlock = b.createBlock({ type: 'quote', content: [{ insert: 'B 的引用' }] });

let updateFromA: Uint8Array | null = null;
docA.on('update', (u: Uint8Array, origin: unknown) => {
  if (origin === LOCAL_ORIGIN) updateFromA = u;
});
const aBlock = a.createBlock({ type: 'paragraph', content: [{ insert: 'A 的并发段落' }] });

a.applyRemoteUpdate(updateFromB!);
docB.transact(() => Y.applyUpdate(docB, updateFromA!, REMOTE_ORIGIN), REMOTE_ORIGIN);

assert(a.getBlock(bBlock)?.getPlainText() === 'B 的引用', 'A 合并了 B 的并发新增');
assert(b.getBlock(aBlock)?.getPlainText() === 'A 的并发段落', 'B 合并了 A 的并发新增');
assert(a.length === b.length, '双端块数量收敛一致');
assert(JSON.stringify(a.getIds()) === JSON.stringify(b.getIds()), '双端块顺序收敛一致');

// 7) 增量幂等：重复 apply 不产生重复内容
const snapshot = a.length;
a.applyRemoteUpdate(updateFromB!);
a.applyRemoteUpdate(updateFromB!);
assert(a.length === snapshot, '重复应用同一增量幂等（长度不变）');

// 8) 剪贴板：复制 -> 粘贴到另一个文档（新 ID）
const data = copyAll(a);
const payload = toDataTransfer(data);
const reparsed = parseClipboard(payload.json);
assert(reparsed !== null && reparsed.blocks.length === a.length, '剪贴板序列化往返完整');
const docC = new Y.Doc();
const c = new BlockDoc(docC, { userId: 'u3' });
const result = pasteBlocks(c, reparsed!);
assert(result.ids.length === reparsed!.blocks.length, '粘贴块数量与剪贴板一致');
assert(result.ids.every((id) => !a.getIds().includes(id)), '粘贴产生全新块 ID，不与源文档冲突');
c.undo();
assert(c.length === 0, '粘贴作为单事务进入撤销栈，一次 undo 全量回退');

console.log(`\n全部 ${passed} 项内核断言通过`);
