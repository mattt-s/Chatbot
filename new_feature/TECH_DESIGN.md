# 群组能力技术方案

## 1. 目标与约束

本方案基于当前项目技术现状设计，不假设引入数据库、不重构整个消息链路，优先采用“在现有 `panel + JSON store + provider ingress` 上增量扩展”的路线。

当前已知技术约束：

- 前端为 Next.js App Router + React 19。
- 后端为 Next.js Route Handler。
- 实时链路为浏览器 SSE + 插件 WebSocket bridge。
- 持久化为 `storage/app-data.json` 单文件。
- 当前 provider ingress 接口以单 `panel.id` + 单 `agentId` 投递。
- 当前 `StoredPanel` 是一级会话对象，没有群组概念。

结论：

- 群组能力不能只做前端 UI，需要扩展存储模型、消息路由和回流映射。
- 但不建议第一期重构 provider 插件为真正多租户编排器，成本高、风险大。

## 2. 推荐设计思路

推荐采用“双层模型”：

- 顶层继续保留 `panel` 作为聊天容器。
- 当 `panel.kind = "group"` 时，该 `panel` 不再代表单角色，而代表一个群组会话容器。
- 群组内角色作为新的 `groupRole` 实体存在。
- 用户在群组 panel 中发送一条消息时，服务端先解析 `@角色`，再拆分为 N 次对 provider 的单角色投递。
- provider 回流时，消息需要带上“来自哪个 groupRole”的标识，再回写到同一个群组 panel 下。

这样做的优点：

- 最大限度复用现有 panel 页面、SSE 订阅、消息持久化与 UI 组件。
- 对外层页面结构改动较小。
- 单角色 panel 的现有逻辑可保留。

## 3. 数据模型调整

## 3.1 扩展 `AppData`

当前：

```ts
interface AppData {
  users: StoredUser[];
  panels: StoredPanel[];
  messages: StoredMessage[];
}
```

建议新增：

```ts
interface AppData {
  users: StoredUser[];
  panels: StoredPanel[];
  messages: StoredMessage[];
  groupRoles: StoredGroupRole[];
}
```

必要时也可显式新增 `groups`，但更推荐复用 `panels` 承载群组容器，避免重复抽象。

## 3.2 扩展 `StoredPanel`

建议新增字段：

```ts
type PanelKind = "direct" | "group";

interface StoredPanel {
  id: string;
  userId: string;
  title: string;
  agentId: string | null;
  kind?: PanelKind;
  sessionKey: string;
  activeRunId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

说明：

- 现有普通角色面板：`kind = "direct"`，`agentId` 保持必填。
- 群组面板：`kind = "group"`，`agentId = null`。
- 这样首页仍可按 `panels` 拉取列表，不需要新增一套顶层容器集合。

## 3.3 新增 `StoredGroupRole`

建议新增：

```ts
interface StoredGroupRole {
  id: string;
  panelId: string; // 群组 panel id
  agentId: string;
  title: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

说明：

- `panelId` 直接指向群组 panel。
- `enabled` 用于移除角色后的软删除，便于保留历史。

## 3.4 扩展 `StoredMessage`

建议新增字段：

```ts
type MessageActorType = "user" | "group-role" | "system";

interface StoredMessage {
  id: string;
  panelId: string;
  role: MessageRole;
  actorType?: MessageActorType;
  groupRoleId?: string | null;
  mentionedGroupRoleIds?: string[];
  replyTarget?: {
    type: "user" | "group-role";
    id: string;
  } | null;
}
```

说明：

- 现有 `role=user/assistant/system` 仍保留，以兼容 UI。
- `actorType + groupRoleId` 用于区分“这条 assistant 消息是哪个群角色发的”。
- `mentionedGroupRoleIds` 用于记录路由结果，便于调试和测试。

## 4. 前端方案

## 4.1 DashboardShell

当前 `DashboardShell` 只认顶层 `panels`。建议：

- 维持 `panels` 为首页唯一数据源。
- `PanelView` 新增 `kind`、`groupRoles`、`groupRoleCount`。
- 侧边栏根据 `kind` 渲染两种 item：
  - `direct`：现有角色项
  - `group`：群组项，可附带群角色摘要

## 4.2 群组页面

在 `PanelCard` 基础上扩展，不单独新建页面类型。

当 `panel.kind === "group"` 时：

- 头部标题显示群组名。
- 头部显示 `添加角色`、`角色管理`。
- 消息区需要根据 `message.groupRoleId` 显示不同发送者标签/头像。
- 输入框 placeholder 改为群组文案。

## 4.3 创建群组与添加角色弹窗

建议复用现有弹窗模式：

- 创建群组：新增 `CreateGroupDialog`
- 添加角色：复用 `CreateRoleDialog` 的表单结构，但提交目标变为群组角色，而不是顶层 panel。

## 4.4 输入框 @ 候选能力

群组页输入框需要新增 mention 辅助层。

推荐交互：

- 当输入框内容为单独一个 `@` 时，弹出候选列表。
- 候选列表只展示摘要，不展示群组树状展开结构。
- 候选列表排除当前用户自己。
- 点击候选项后，向输入框插入 `@名称`。

实现建议：

- 在 [components/panel-composer.tsx](../components/panel-composer.tsx) 增加 group 模式下的 mention UI 状态。
- 新增轻量候选组件，例如 `MentionPicker`。
- 候选数据直接使用群组详情接口返回的 `groupRoles` 与当前用户信息，不额外引入远端搜索。

本期不建议做：

- 模糊搜索
- 富文本 token
- 键盘复杂导航

## 5. API 设计

## 5.1 群组

建议新增：

- `POST /api/groups`
- `PATCH /api/groups/[groupId]`
- `DELETE /api/groups/[groupId]`（如本期需要）

但考虑当前系统以 `panels` 为主，也可以不引入 `/api/groups`，直接用：

- `POST /api/panels` 支持 `kind = "group"`

推荐方案：

- 为了减少认知混乱，新增明确接口：
  - `POST /api/groups`
  - 内部落地为创建 `kind=group` 的 panel

## 5.2 群角色

建议新增：

- `POST /api/groups/[groupId]/roles`
- `GET /api/groups/[groupId]/roles`
- `DELETE /api/groups/[groupId]/roles/[roleId]`

## 5.3 群消息发送

建议在现有 `POST /api/customchat/webhook` 上扩展，不新增第二套发送入口。

新流程：

1. 通过 `panelId` 获取 panel。
2. 若 `panel.kind === "direct"`，走现有逻辑。
3. 若 `panel.kind === "group"`：
   - 解析消息中的 `@角色名`
   - 找到命中的 `groupRoles`
   - 先写入一条用户消息到该群组 panel
   - 对每个命中角色分别执行一次 provider dispatch
   - 为每次 dispatch 生成独立 `runId`

规则要求：

- `@角色名` 使用严格匹配。
- 一条消息允许同时命中多个角色。
- 输入框候选只负责补全，不改变最终服务端严格匹配规则。

返回结构建议从单 run 扩展为多 run：

```ts
{
  ok: true,
  status: "started",
  runIds: string[],
  userMessage: MessageView
}
```

兼容策略：

- direct panel 仍返回单 `runId`
- group panel 返回 `runIds`

## 6. Provider 与回流设计

这是本需求最关键的部分。

## 6.1 当前现状

`submitPanelMessage()` 当前通过 `dispatchViaProvider()` 发送：

- `panel.id`
- `agentId`
- `target: direct:${panel.id}`

这套结构假设“一次消息只对应一个 agent”。

## 6.2 群组方案

群组消息不能直接使用 `panel.agentId`，因为群组内有多个角色。

建议新增 dispatch 输入：

```ts
{
  panelId: string;
  groupRoleId: string;
  agentId: string;
  messageId: string;
  text: string;
}
```

并将 `target` 编码为：

```ts
group:${panelId}:role:${groupRoleId}
```

或更稳妥一些：

```ts
panel:${panelId}:group-role:${groupRoleId}
```

要求：

- provider 回流时必须把这个 target/sessionKey 原样带回。
- app 在 ingest 时据此定位群组 panel 与 groupRoleId。

## 6.3 ingest 扩展

当前 `ingestCustomChatDelivery()` 是通过 target 找 panel，再 upsert assistant message。

群组模式需要：

1. 解析 target/sessionKey
2. 识别是否来自 group role
3. 将回流消息写入对应群组 panel
4. 在消息记录中附带 `groupRoleId`

这样前端才能把消息渲染成“角色1回复”、“角色2回复”。

同时建议把“回复目标快照”写入消息，供前端在气泡右下角展示：

```ts
replyTarget?: {
  type: "user" | "group-role";
  id: string;
  label: string;
  avatarUrl?: string | null;
  emoji?: string | null;
} | null;
```

## 7. Store 层改造

建议新增的 store 方法：

- `createGroup(userId, title)`
- `listGroupRoles(panelId)`
- `createGroupRole(userId, panelId, agentId, title)`
- `removeGroupRole(userId, panelId, roleId)`
- `findGroupRoleByMention(panelId, mention)`
- `appendGroupUserMessage(...)`
- `appendGroupAssistantMessage(...)`

建议修改的方法：

- `listPanelsForUser()`
- `getPanelRecordForUser()`
- `panelToView()`
- `upsertAssistantMessage()`

注意：

- `removeGroupRole()` 应优先软删除，不建议物理删除。
- 历史消息展示依赖 `groupRoleId` 对应的名称快照；否则角色被删除后名字会丢失。

因此建议在消息中增加发送者快照：

```ts
senderLabel?: string | null;
```

同时建议增加回复目标展示快照：

```ts
replyTargetLabel?: string | null;
replyTargetAvatarUrl?: string | null;
replyTargetEmoji?: string | null;
```

## 8. 类型层改造

需要修改 [types.ts](../lib/types.ts)：

- `StoredPanel`
- `StoredMessage`
- `PanelView`
- `ChatEventPayload`
- 新增 `StoredGroupRole`
- 新增 `GroupRoleView`

建议新增：

```ts
export interface GroupRoleView {
  id: string;
  panelId: string;
  agentId: string;
  title: string;
  enabled: boolean;
}
```

`PanelView` 扩展：

```ts
groupRoles?: GroupRoleView[];
kind?: "direct" | "group";
```

## 9. UI 数据聚合

`loadDashboardData()` 当前只加载：

- channel
- agents
- panels

建议继续保持这个入口，但 `listPanelsForUser()` 需要在返回 `PanelView` 时带上群组角色摘要，避免首页再打额外请求。

群组详情页若需要完整角色列表，可在：

- `GET /api/panels/[panelId]`

直接返回完整 `groupRoles`。

mention 候选也建议复用该接口返回的数据，不单独增加搜索接口。

## 10. 向后兼容策略

旧数据没有：

- `panel.kind`
- `groupRoles`
- `message.groupRoleId`

兼容方案：

- 读取时默认 `panel.kind = "direct"`
- 缺少 `groupRoles` 时按空数组处理
- 缺少 `groupRoleId` 时按普通 assistant 消息处理

这意味着无需一次性数据迁移脚本，也能先让功能逐步上线。

## 11. 风险与取舍

## 11.1 风险：单 JSON 文件继续膨胀

群组、群角色、多 run 路由都会增加 `app-data.json` 复杂度。

结论：

- 本期可接受。
- 但如果群组能力成为主流程，后续应迁移到 SQLite 或 PostgreSQL。

## 11.2 风险：一个用户消息对应多个 run

当前前端把 `activeRunId` 视为单值。群组模式下这不成立。

建议：

- direct panel 保持 `activeRunId`
- group panel 新增 `activeRunIds: string[]`

如果第一期不想改动太大，也可退而求其次：

- 群组页不展示精确的逐 run loading 状态
- 仅展示“群组处理中”

## 11.3 风险：provider 插件是否支持多 target 回流

如果 provider 插件内部假设一个消息只面向一个 target，需要同步修改插件的路由状态记录。

结论：

- 技术方案必须包含插件配套改造。
- 否则前端做完也无法闭环。

## 12. 推荐实施顺序

### Step 1 数据层

- 扩展 types
- 扩展 `AppData`
- 新增 group role store API
- 增加 panel kind

### Step 2 UI 层

- 左侧列表支持群组项
- 群组页头部与弹窗
- 角色管理弹窗

### Step 3 消息路由层

- `@角色` 解析
- 群组消息发送入口
- 多角色 dispatch

### Step 4 回流层

- provider target 编码扩展
- ingest 写入 groupRoleId
- 前端消息渲染显示发送者

### Step 5 测试与回归

- 单元测试
- API 集成测试
- 手工联调

## 13. 最小可行版本

如果要控制改动范围，建议第一版只做：

- 群组 panel 创建
- 群组内角色 CRUD
- `@角色` 解析
- 一条群消息拆分成多条 provider dispatch
- 回流消息标记发送角色
- 输入单独 `@` 时展示候选并支持点击补全
- 被 `@` 对象在气泡右下角独立展示

暂不做：

- 角色回复其他角色的结构化链路
- 群组内复杂展开树
- 精细化多 run 状态管理

## 14. 结论

这项需求在当前项目上可以实现，但不是“纯前端功能”。最小闭环至少需要改动三层：

- 存储模型：支持群组与群角色
- 消息路由：支持 `@角色` -> 多 agent dispatch
- 回流映射：支持把 assistant 消息归属于具体群角色

推荐基于现有 `panel` 模型做“群组型 panel”扩展，而不是新起一套完全独立的群组体系。这样复用率最高，风险最低，也最符合当前项目的技术现状。
