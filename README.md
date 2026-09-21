# BlockEditor · 分布式块级协同编辑器

基于 **Yjs CRDT** 的分布式块级协同编辑器。npm workspaces 单体仓库，四个包协作：

| 包 | 职责 | 技术 |
|---|---|---|
| `packages/proto` | y-protobuf 二进制帧协议（零依赖手写 protobuf wire codec） | TypeScript / y-protocols |
| `packages/core` | 块文档模型内核：自定义块 CRDT 类型、撤销栈、剪贴板 | TypeScript / Yjs |
| `packages/client` | Vue3 应用、自研块渲染引擎、离线持久化、协同连接 | Vue3 / y-indexeddb / Vite |
| `packages/server` | NestJS 协同服务：房间管理、WebSocket、长轮询、存储 | NestJS / ws / PostgreSQL / Redis |

## 功能与实现对照

### 1. 块文档模型内核（`packages/core`）
- **四类内置块**：`paragraph` / `heading` / `quote` / `code`（`src/registry.ts`）。
- **统一块元数据**：`meta`（唯一 ID、类型、parentId、创建者、创建/更新时间）+ `attrs`（块级自定义属性）+ `text`（`Y.XmlText` 行内富文本）。
- **Yjs CRDT 封装**：`blocks: Y.Map<id, YBlock>` + `order: Y.Array<id>`；块新增 / 删除 / 修改 / 移动全部经 `BlockDoc.transactLocal` 事务驱动（`src/block-doc.ts`、`src/block-node.ts`）。
- **块结构隔离**：每块独立 `Y.XmlText`，支持 bold/italic/underline/strike/code/color/link 行内样式；块拆分 / 合并保留行内 Delta。
- **全局块复制粘贴**：跨文档逻辑剪贴板格式（`src/clipboard.ts`），粘贴时重分配块 ID，纯文本兜底，跨设备安全。
- **扩展注册接口**：`BlockRegistry.register()` 为迭代 2 表格、图片块预留；未注册类型自动降级为段落。

### 2. 离线优先与本地持久化（`packages/client/src/offline`）
- IndexedDB + `y-indexeddb` 持久化 Yjs 状态，另有 `pending-updates`（待同步二进制增量队列）、`temp-state`（临时状态）两个存储。
- 断网可全量编辑：本地事务增量（幂等键 `clientID:seq`）落队列，杀进程不丢。
- 网络恢复：sync step1/2 校验并自动合并远端 → 按序幂等推送队列 → 服务端 Ack 出队（`src/network/network.ts`）。Yjs 更新天然幂等，重放安全。
- **在线离线通用撤销重做栈**：`Y.UndoManager` 只追踪 `LOCAL_ORIGIN` 事务，远端合并不进栈，`captureTimeout: 0` 保证每个操作独立可回退。

### 3. 多人实时协同
- WebSocket 文档房间 `/collab/ws?doc=<id>`，按文档 ID 隔离（`src/collab/collab.gateway.ts`、`room.ts`、`room-manager.service.ts`）。
- **y-protobuf 二进制增量**：所有传输均为 `[uint32 长度][protobuf Frame]` 二进制（`packages/proto`，附标准 `.proto` 描述），无明文文本。
- **光标 / 选区**：经 y-protocols awareness 以二进制增量广播；用户色由用户 ID 确定性分配 HSL（`colorForUser`），前端覆盖层渲染远端光标与跨行选区（`src/render/remote-cursor-layer.ts`）。
- **冲突合并**：并发块新增 / 删除 / 移动由 CRDT 自动收敛，服务端不做业务裁决。

### 4. 自研块渲染引擎（`packages/client/src/render`）
- 不依赖任何富文本 DOM 框架；只订阅 `BlockDoc` 的事务变更事件。
- **局部更新**：rAF 合帧，按块 ID 增删移动，块移动仅 `insertBefore`，行内文本由各块 `TextBinding` 单独回流。
- **虚拟滚动**：上下高度衬垫 + overscan，仅挂载视口附近块 DOM，支持长文档。
- contentEditable 的 `beforeinput` 统一翻译为 Y.XmlText 事务，DOM 永不脱离模型。

### 5. 后端配套（`packages/server`）
- NestJS + `@nestjs/platform-ws` 二次封装 y-websocket 语义（protobuf 帧、强制权限、DI 注入）。
- **HTTP 长轮询降级**：`POST /api/collab/poll/:docId`，与 WebSocket 共用同一房间 / sync / awareness 逻辑；客户端 8s 连不上 WS 自动切换。
- **PostgreSQL**：users / documents / permissions / ydoc_state（`src/database/schema.sql`）；CRDT 全量状态防抖落盘，房间重建时恢复。
- **Redis**：在线用户集合、临时光标 awareness 快照（TTL 30s）。
- **权限**：owner / editor / reader 全局文档级读写；`PermissionsService` 内预留块级权限扩展接口。
- **对象存储**：图片等二进制资源的上传下载接口（S3 兼容，本地目录降级）。
- PostgreSQL / Redis 不可用时自动降级为本地文件 / 进程内缓存，**零基础设施即可开发运行**。

## 快速开始

```bash
# 1. 安装依赖（Node >= 20）
npm install

# 2. 启动后端（默认 :3000；无 PG/Redis 时自动降级）
npm run dev:server

# 3. 启动前端（:5173，已配置 /api 与 /collab/ws 代理）
npm run dev:client
```

浏览器打开 http://localhost:5173 → 输入昵称演示登录 → 新建文档。开两个浏览器窗口（或一个普通窗口 + 一个无痕窗口，用不同昵称登录）即可看到实时协同与彩色光标。

启用 PostgreSQL / Redis：复制 `packages/server/.env.example` 并通过环境变量提供 `DATABASE_URL`、`REDIS_URL`。

## 验证

```bash
# 协议 wire-format 往返
npm run test:proto

# 内核 CRDT 冒烟（21 项：CRUD/移动/拆分合并/撤销/双端并发收敛/幂等/剪贴板）
npx tsx packages/core/test/smoke.ts

# 端到端协同（需先启动服务端；10 项：登录/建文档/WS 握手/增量广播/
# 幂等重放/Ack/光标/持久化恢复）
npx tsx packages/server/test/e2e.ts

# 全量类型检查 + 前端生产构建
npm run typecheck
npm run build -w @blockeditor/client
```

## 协议帧

```
物理消息 = [uint32 BE len][Frame] ...        // WebSocket 与长轮询统一
Frame (protobuf) = kind | doc_id | payload | client_id | ref
```

`payload` 内承载标准 y-protocols 消息（sync step1/step2/update、awareness update），
因此与 y-websocket 生态在 sync 语义层完全互通；`ref` 为离线增量的幂等键，
服务端合并成功后以 `Ack` 回填。详见 `packages/proto/proto/blockeditor.proto`。

## 迭代 2 扩展点
- 表格 / 图片块：`BlockRegistry.register()` + 渲染引擎 `customBlockClass` 钩子；图片走对象存储接口，块内仅存 URL。
- 块级权限：`PermissionsService.requireBlockRole`（设计注释见源码）。
- 多实例部署：RoomManager 接 Redis 房间路由 + pub/sub（当前单实例，接口已预留）。
