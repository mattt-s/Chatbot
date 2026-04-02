# 测试说明

## 运行方式

```bash
# 运行全部测试
npm test

# 监听模式（修改代码自动重跑）
npm run test:watch

# 生成覆盖率报告
npm run test:coverage
```

## 技术栈

| 项目 | 选型 |
|------|------|
| 测试框架 | [Vitest](https://vitest.dev/) 2.x |
| Mock | Vitest 内置 `vi.mock()` / `vi.fn()` / `vi.spyOn()` |
| 断言 | Vitest 内置（兼容 Jest `expect` API） |
| 环境 | Node（不需要浏览器） |

配置文件：[`vitest.config.ts`](../vitest.config.ts)

---

## 测试覆盖总览

共 **10 个测试文件，197 个用例**，覆盖除 `plugins/customchat` 以外的所有模块。

| 测试文件 | 覆盖模块 | 用例数 | Mock 策略 |
|---------|---------|:------:|----------|
| [`utils.test.ts`](#1-libutils) | `lib/utils.ts` | 79 | 无（纯函数） |
| [`env.test.ts`](#2-libenv) | `lib/env.ts` | 6 | `process.env` |
| [`store.test.ts`](#3-libstore) | `lib/store.ts` | 34 | `fs`、`env` |
| [`auth.test.ts`](#4-libauth) | `lib/auth.ts` | 9 | `jose`、`next/headers`、`store` |
| [`customchat-events.test.ts`](#5-libcustomchat-events) | `lib/customchat-events.ts` | 3 | `server-only` |
| [`customchat-ingest.test.ts`](#6-libcustomchat-ingest) | `lib/customchat-ingest.ts` | 12 | `store`、`events` |
| [`customchat-provider.test.ts`](#7-libcustomchat-provider) | `lib/customchat-provider.ts` | 5 | `fetch`、`env` |
| [`agents.test.ts`](#8-libagents) | `lib/agents.ts` | 5 | `fetch`、`env` |
| [`chat-helpers.test.ts`](#9-componentschat-helpers) | `components/chat-helpers.tsx` | 19 | 无（纯逻辑函数） |
| [`runtime-helpers.test.ts`](#10-componentsruntime-helpers) | `components/runtime-helpers.ts` | 25 | 无（纯函数） |

---

## 各模块详细说明

### 1. lib/utils

**源文件**：[`lib/utils.ts`](../lib/utils.ts)
**测试文件**：[`__tests__/lib/utils.test.ts`](../__tests__/lib/utils.test.ts)

项目中最大的纯函数集合，全部可以直接测试，不需要任何 mock。

| 函数 | 测试内容 |
|------|---------|
| `nowIso()` | 返回合法 ISO 日期字符串 |
| `randomId()` | 非空、唯一性（50次不重复） |
| `buildSessionKey()` | 返回 `panel:<panelId>` 格式 |
| `stripAgentSessionPrefix()` | 剥离 `agent:<id>:` 前缀 |
| `toCustomChatPanelTarget()` | 生成 `panel:<id>` |
| `toCustomChatReplyTarget()` | 规范化回复目标 |
| `normalizeCustomChatTarget()` | **17 个用例**，覆盖 `panel:`、`channel:`、`session:`、`direct:`、`group:`、`customchat:`、`agent:<id>:`、`panel-<uuid>` 等全部前缀格式，含空值/嵌套/深层递归场景 |
| `sanitizeFilename()` | 路径剥离、特殊字符替换、连续横杠折叠、空 stem 回退 |
| `classifyAttachment()` | image/audio/video/file 四种分类 |
| `formatBytes()` | B/KB/MB/GB 单位格式化，含精度控制 |
| `attachmentToView()` | sourceUrl 优先、fallback 到 `/api/uploads/:id` |
| `isIgnorableStoredRuntimeStep()` | 过滤 assistant/lifecycle stream 和 raw type |
| `sanitizeRuntimeSteps()` | 批量过滤不可见步骤 |
| `messageToView()` | 完整字段转换、runtime steps 过滤 |
| `inferMimeTypeFromPath()` | 20+ 种文件后缀识别，含 query/hash 剥离 |
| `filenameFromUrl()` | URL 提取文件名、file:// 协议、空值 fallback |
| `toLocalFilePath()` | Unix 绝对路径、Windows 路径、file:// 转换、http 返回 null |
| `extractMessageText()` | text 字段、content 数组、NO_REPLY 剥离、null/undefined 安全 |
| `extractMessageAttachments()` | content 数组（data URL）、MEDIA: 引用、markdown 图片、去重 |
| `applyChatEventToMessages()` | **12 个用例**，覆盖 delta/final/aborted/error 四种状态、新建/更新消息、seq 乱序拒绝、runtime steps 合并、时间排序 |

---

### 2. lib/env

**源文件**：[`lib/env.ts`](../lib/env.ts)
**测试文件**：[`__tests__/lib/env.test.ts`](../__tests__/lib/env.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `getEnv()` | 默认值（无环境变量时）、`APP_BASE_URL` 读取、`cookieSecure` 自动推断（https→true）、`APP_COOKIE_SECURE` 显式覆盖、WS 端口解析、非法端口回退 |
| `getStorageDir()` 等 | 四个路径函数的返回值正确性 |

**Mock 策略**：直接操作 `process.env`，测试前后恢复原始环境。

---

### 3. lib/store

**源文件**：[`lib/store.ts`](../lib/store.ts)
**测试文件**：[`__tests__/lib/store.test.ts`](../__tests__/lib/store.test.ts)

持久化层的核心模块，测试量最大。

| 函数 | 测试内容 |
|------|---------|
| `findUserByEmail()` | 大小写不敏感匹配、未知邮箱返回 undefined |
| `findUserById()` | ID 精确匹配、未知 ID 返回 undefined |
| `createPanel()` | 创建面板、返回正确的 title/agentId/sessionKey |
| `listPanelsForUser()` | 按用户过滤、包含/排除消息、未知用户返回空 |
| `deletePanel()` | 删除面板及其消息、非 owner 抛异常 |
| `appendUserMessage()` | 添加用户消息、非 owner 抛异常 |
| `upsertAssistantMessage()` | **5 个用例** — 新建消息、同 runId 更新、seq 乱序拒绝、blocked runId 返回 null、未知 panel 抛异常 |
| `abortAssistantRun()` | 中止消息（state→aborted, draft→false）、不存在时返回 null |
| `upsertAssistantRuntimeSteps()` | 新建消息并加步骤、合并已有步骤、空步骤返回 null |
| `setPanelActiveRun()` | 设置和清除 activeRunId |
| `blockPanelRun()` | 添加到 blockedRunIds |
| `updatePanel()` | 更新标题、切换 agentId 时清除消息 |
| `clearPanelMessages()` | 清空面板消息并重置状态 |
| `findPanelRecordBySessionKey()` | 精确匹配、未知 key 返回 null |
| `findPanelRecordByCustomChatTarget()` | 规范化后匹配（如 `channel:p1` → `panel:p1`） |
| `listPanelMessages()` | 按 createdAt 排序返回 |
| `persistUploadedFile()` | 写文件、返回附件元数据 |

**Mock 策略**：
- `fs/promises` — 全部 mock（`readFile` 返回预设 JSON，`writeFile` 记录调用）
- `@/lib/env` — 固定返回测试路径
- 每个测试前 `vi.resetModules()` 清除内存缓存

---

### 4. lib/auth

**源文件**：[`lib/auth.ts`](../lib/auth.ts)
**测试文件**：[`__tests__/lib/auth.test.ts`](../__tests__/lib/auth.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `createSessionToken()` | 返回合法 JWT 字符串（3段结构） |
| `getCurrentUser()` | 无 cookie → null、有效 token → 返回用户、无效 token → null、用户已删除 → null |
| `requireCurrentUser()` | 未登录时 redirect 到 `/login` |
| `authenticateUser()` | 未知邮箱 → null、错误密码 → null、正确密码 → 返回用户 |

**Mock 策略**：
- `next/headers` — mock `cookies()` 返回可控的 cookie store
- `next/navigation` — mock `redirect()` 抛异常以便断言
- `@/lib/store` — mock `findUserByEmail` / `findUserById`
- `@/lib/env` — 固定 sessionSecret
- 密码测试使用真实 `bcryptjs`（不 mock）以验证哈希逻辑

---

### 5. lib/customchat-events

**源文件**：[`lib/customchat-events.ts`](../lib/customchat-events.ts)
**测试文件**：[`__tests__/lib/customchat-events.test.ts`](../__tests__/lib/customchat-events.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `publishCustomChatEvent()` | 调用所有已订阅 listener、单个 listener 抛异常不影响其他 listener |
| `subscribeCustomChatEvent()` | 返回 unsubscribe 函数，取消后不再接收事件 |

**Mock 策略**：仅 mock `server-only`，每个测试前清理全局 `__chatbotCustomChatListeners`。

---

### 6. lib/customchat-ingest

**源文件**：[`lib/customchat-ingest.ts`](../lib/customchat-ingest.ts)
**测试文件**：[`__tests__/lib/customchat-ingest.test.ts`](../__tests__/lib/customchat-ingest.test.ts)

| 功能 | 测试内容 |
|------|---------|
| `customChatDeliverySchema` | Zod schema 验证 — 最小合法 payload、缺失 target 拒绝、四种 state 枚举 |
| `ingestCustomChatDelivery()` | 正常投递 → 存储 + 发布 SSE、final 状态清除 activeRunId、不支持的 target 抛异常、panel 不存在抛异常、blocked runId 静默忽略、空投递（无文字/附件/步骤）忽略、NO_REPLY 和 `<think>` 标签剥离、无 runId 时生成 `customchat:` 前缀、runtime steps 转发 |

**Mock 策略**：mock `store` 全部函数 + `customchat-events`。

---

### 7. lib/customchat-provider

**源文件**：[`lib/customchat-provider.ts`](../lib/customchat-provider.ts)
**测试文件**：[`__tests__/lib/customchat-provider.test.ts`](../__tests__/lib/customchat-provider.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `deleteProviderSession()` | 调用 `session.delete` RPC、参数正确、RPC 失败时抛异常 |
| `abortProviderRun()` | 调用 `session.abort` RPC、参数正确、失败时抛异常 |
| `inspectProviderSession()` | 调用 `session.inspect` RPC |
| `readProviderSessionStatus()` | 调用 `session.status` RPC |

**Mock 策略**：mock `@/lib/customchat-bridge-server`（`sendRpcToPlugin` + `ensureCustomChatBridgeServer`）。

---

### 8. lib/agents

**源文件**：[`lib/agents.ts`](../lib/agents.ts)
**测试文件**：[`__tests__/lib/agents.test.ts`](../__tests__/lib/agents.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `loadAgentCatalog()` | plugin 不可用时回退到环境变量 catalog、RPC 成功时返回并添加 avatarUrl、过滤无效 agent 条目、catalog JSON 格式错误时回退到默认 |
| `getChannelView()` | 返回固定的 channel 视图结构 |

**Mock 策略**：mock `@/lib/customchat-bridge-server`（`sendRpcToPlugin` + `isPluginConnected` + `ensureCustomChatBridgeServer`）+ `@/lib/env`。

---

### 9. components/chat-helpers

**源文件**：[`components/chat-helpers.tsx`](../components/chat-helpers.tsx)
**测试文件**：[`__tests__/components/chat-helpers.test.ts`](../__tests__/components/chat-helpers.test.ts)

> 只测试纯逻辑函数，跳过需要 React DOM 的 `renderLinkedText` 和 `buildOptimisticUserMessage`。

| 函数 | 测试内容 |
|------|---------|
| `truncateText()` | 短文本不截断、长文本加 `...` |
| `matchesPanelSession()` | null 返回 false、精确匹配、规范化后匹配（`channel:` → `panel:`）、不同 panel 不匹配 |
| `normalizeChatEventRunId()` | **7 个用例** — 无 activeRunId 不合并、runId 相同不合并、delta 状态不合并、customchat:* activeRunId 合并到 gateway runId、真实 gateway activeRunId 不合并独立投递、两个 customchat:* 不互相合并、无 draft 不合并 |
| `isBridgeDeliveryMessage()` | user 消息 → false、有附件 → false、有 runtimeSteps → false、空文本 → true、文本为 "no"/"NO" → true、有实际文本 → false |

---

### 10. components/runtime-helpers

**源文件**：[`components/runtime-helpers.ts`](../components/runtime-helpers.ts)
**测试文件**：[`__tests__/components/runtime-helpers.test.ts`](../__tests__/components/runtime-helpers.test.ts)

| 函数 | 测试内容 |
|------|---------|
| `describeRuntimeData()` | **12 个用例** — lifecycle start/end 识别、exec 类型（含 exitCode 成功/失败）、write/read/edit/search/process 类型检测、未知工具回退到 step、error 处理、stream 名称格式化 |
| `isAssistantTextStep()` | stream="assistant-text" 和 raw.type="assistant-text" 识别 |
| `isIgnorableRuntimeStep()` | assistant/lifecycle stream 和 raw type 过滤 |
| `normalizeRuntimeStepForDisplay()` | assistant-text 原样返回、tool step 通过 describeRuntimeData 增强 |
| `hasMessageToolRuntimeStep()` | raw.tool="message" / raw.name="message" 检测、无 message 工具返回 false、空数组返回 false |

---

## 未覆盖的模块

| 模块 | 原因 |
|------|------|
| `plugins/customchat/index.ts` | ~4000 行，深度耦合 Gateway WebSocket，建议先重构再测 |
| `lib/customchat-bridge-server.ts` | WebSocket 服务器，需要集成测试环境 |
| `lib/server-data.ts` | 编排层，调用其他已测模块 |
| `lib/panel-message.ts` | 编排层，调用 store + provider |
| React 组件渲染 | 需要 `jsdom` 环境 + `@testing-library/react`，当前只测了纯逻辑函数 |
