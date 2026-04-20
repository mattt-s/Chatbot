# 群组任务模式技术方案

> 状态：实现中

## 概述

在现有群聊模式（`chat`）之外，新增一种**任务驱动协作模式**（`task`）。

- **群聊模式**：用户发消息 → leader / 角色自由对话路由，消息驱动
- **任务模式**：用户给目标 → leader 拆分为工单 → 工单驱动执行，结构化流转

两种模式在创建群组时选择，一旦创建后不可切换，运行时逻辑完全分支。

---

## 🔴 架构隔离原则（最重要）

**任务模式和群聊模式必须在代码层完全独立，不允许通过修改现有函数来"兼容"任务模式。**

### 硬性约束

1. **独立模块路径**：任务模式的所有新代码放在独立目录下，不混入现有的聊天模式代码
   - 后端：`lib/task-mode/*`（新建目录）
   - 前端：`components/task-mode/*`（新建目录）
   - API：`app/api/panels/[panelId]/group-tasks/*`（新建路径）
   - 提示词：`prompt/group-task-*.md`（新建文件）

2. **禁止在现有函数上加模式分支**：
   - ❌ **不允许**：在 `customchat-ingest.ts`、`panel-card.tsx`、`group-router.ts` 等现有文件里加 `if (groupMode === "task") {...} else {...}` 分支
   - ✅ **允许**：在最外层入口处（例如面板渲染、ingest 派发）根据 `groupMode` **分流到完全独立的模块**，之后两条路径互不相见

3. **入口分流点**必须显式且集中：
   - 前端：`panel-card.tsx` 在最顶层判断 `groupMode`，任务模式直接返回 `<TaskModePanelCard />`，后续 UI、SSE、store 全走任务模式的独立实现
   - 后端 ingest：在 `customchat-ingest.ts` 入口做一次分流，任务模式交给 `lib/task-mode/ingest.ts` 处理，之后不再回到聊天代码
   - 后端 RPC：`group_task.*` 走独立的 `lib/task-mode/app-rpc-handlers.ts`，不与 `customchat-app-rpc.ts` 的聊天 handler 混用
   - Tool 注册：`group_task` tool 代码独立于 `group_route` tool，提示词里按模式引导 agent 用不同的 tool

4. **复用策略**：
   - 纯工具函数（无模式特化、签名稳定）可以复用，例如 `getPanelRecordForUser`、`nowIso`、`mutateData` 这种基础设施
   - 任何**需要加参数、加分支、加可选字段才能"兼容"任务模式的函数，一律复制一份到 `task-mode/` 下独立维护**，不要改原函数签名或内部逻辑
   - 遇到"看起来能复用、但需要加一点点改造"的情况，默认选择**复制独立实现**

### 动机

- 聊天模式代码是已稳定运行的产线代码，任何改动都有回归风险
- 任务模式是独立的协作范式，强行共用代码会让两边都变复杂、边界模糊
- 宁可容忍局部代码重复，也要保证两种模式各自的实现清晰可读、易于独立修改和测试
- 未来如果确实发现了稳定的公共抽象，可以再从两个独立实现里提炼出来放到 `lib/shared/`，而不是一开始就假设能抽象

### 分流示意

```
用户请求 / agent 消息事件
      ↓
   [入口点]
      ↓
  判断 groupMode
      ├── "chat" → 走现有全套代码（customchat-ingest / group-router / panel-card 聊天分支 / group_route tool）
      └── "task" → 走 lib/task-mode / components/task-mode / group_task tool，后续完全独立
```

**审查时请明确拒绝"在现有函数加 if 分支"这种改动。**

---

## 任务状态机

```
pending_approval → assigned → in_progress → submitted → reviewing → done
                ↗                        ↘ blocked ↗           ↘ rejected → in_progress（重新执行）
         created                                                           ↘ needs_intervention → cancelled（用户放弃）
                                                                                                ↘ assigned（用户重新唤起/改派）
```

| 状态 | 含义 | 触发方 | 是否终态 |
|---|---|---|---|
| `pending_approval` | 成员提出的子任务，等待 leader 审批 | 成员调用 `group_task(create_task)`（非 leader） | 否 |
| `created` | 任务已创建，等待前置任务完成 | leader 或成员（成员走 pending_approval 先） | 否 |
| `assigned` | 已分配给执行者，等待认领 | app 自动（创建时无前置 / 所有前置完成 / blocked 恢复 / reject 后退回） | 否 |
| `in_progress` | 执行者认领，正在执行 | assignee 调用 `group_task(start_task)` | 否 |
| `blocked` | 执行中发现阻塞，等待新追加的前置任务完成 | assignee 调用 `group_task(block_on)` | 否 |
| `submitted` | 执行者提交，等待验收 | assignee 调用 `group_task(submit_task)` | 否 |
| `reviewing` | leader 审核中 | app 自动（submit 后通知 leader） | 否 |
| `done` | 验收通过 | leader 调用 `group_task(approve_task)` 或 autoApprove 自动通过 | **是** |
| `rejected` | 验收不通过，**退回执行者重做**（非终态，任务仍要继续） | leader 调用 `group_task(reject_task)` | 否 |
| `needs_intervention` | watchdog 连续重试失败，需要用户介入 | app 自动（watchdog 达到重试上限） | **准终态**（可恢复） |
| `cancelled` | 用户主动放弃任务，永久终止 | 用户在前端操作（仅限 `needs_intervention` 状态） | **是** |

**关键规则：**
- `start_task` 前置状态既可以是 `assigned` 也可以是 `rejected`（rejected 走同一路径重新开工）
- `rejected` **不是终态**：任务退回后仍需被 assignee 重做。`rejected` 不释放该 assignee 的 pending dispatch 队列，退回的任务本身排在队首等待 start_task
- 只有 `done` / `cancelled` 才是真正的终态，会触发队列释放和下游依赖检查
- `needs_intervention` 是"准终态"：app 不再自动 dispatch，但用户可以恢复（重新唤起 → `assigned` / 改派 → `assigned` / 放弃 → `cancelled`）
- `cancelled` 后其下游依赖任务不会被自动触发；如需继续，leader 应手动解除对应依赖或重新创建任务

---

## 完整状态流

### 主流程（leader 创建，无前置依赖）

```
1. 用户向 leader 下达目标
2. leader 调用 create_task(assigneeTitle, description, autoApprove?)
3. app 存储任务，status=assigned，dispatch 分配消息给 assignee
4. assignee 收到消息，调用 start_task(taskId)
5. app 更新 status=in_progress
6. assignee 执行完毕，调用 submit_task(taskId, note)
   ├── autoApprove=true → status=done，写 approved 事件，检查触发后续依赖任务
   └── autoApprove=false → status=reviewing，dispatch 验收请求给 leader
7. leader 收到验收请求
   ├── 通过 → approve_task(taskId) → status=done，触发后续依赖任务
   └── 不通过 → reject_task(taskId, note) → status=rejected
                → 退回消息走 assignee 的 pending dispatch 队列（详见下文"同一 assignee 的任务串行化"），不抢占当前任务
8. assignee 收到退回消息（队列到达时），调用 start_task(taskId)（前置状态为 rejected），status=in_progress，回到步骤 5
```

### 同一 assignee 的任务串行化

一个 assignee 同时只能执行一个任务。当 app 需要向某 assignee dispatch 新任务，但该 assignee 当前有 `in_progress` / `blocked` 任务时，走**排队机制**：

```
1. 新任务 status 保持 assigned，app 不立即 dispatch
2. 加入该 assignee 的 pending dispatch 队列
3. 当前任务到达真正终态（done / cancelled）或到达 needs_intervention 后，app 从队列取下一个任务 dispatch
```

队列按任务创建时间 FIFO 排序。**这个队列不是聊天模式的 busy 队列**，而是专属于任务模式的 assignee pending dispatch 队列，由 app 维护。

> ⚠️ **`rejected` 不释放队列**：`rejected` 是"退回重做"，不是任务终结。被 reject 的任务本身会重新排在该 assignee 队首等待 start_task，此时不应同时 dispatch 队列中的其他任务，否则 assignee 会同时收到两个任务。队列释放只在 `done` / `cancelled` / `needs_intervention` 时触发。

### 带前置依赖的任务

```
1. leader 创建任务 B 时指定 dependsOnTaskIds=["taskA-id"]
2. 任务 B status=created（等待中）
3. 任务 A 完成（status=done）
4. app 检查：taskA 的所有依赖任务是否均为 done
   ├── 是 → 自动将任务 B status 置为 assigned，dispatch 分配消息给 B 的 assignee
   └── 否 → 继续等待其他前置任务
```

### 成员提子任务（需 leader 审批）

```
1. assignee 执行任务时发现依赖其他角色
2. assignee 调用 create_task(assigneeTitle=otherRole, parentTaskId=currentTask)
3. app 检测到调用方非 leader → status=pending_approval，dispatch 审批请求给 leader
4. leader 调用 approve_subtask(taskId) → status 转为正式 assigned 流程
   或 reject_subtask(taskId, note) → 任务废弃，通知 assignee 自行处理
```

---

## 数据模型

### StoredGroupTask

```typescript
type GroupTaskStatus =
  | "pending_approval"  // 成员提出的子任务，等 leader 审批
  | "created"           // 已创建，等待前置任务完成
  | "assigned"          // 已分配，等待认领
  | "in_progress"       // 执行中
  | "blocked"           // 执行中发现阻塞，等待新增的前置任务完成后自动恢复
  | "submitted"         // 已提交，等待验收
  | "reviewing"         // leader 审核中
  | "done"              // 已完成（终态）
  | "rejected"          // 退回，自动 dispatch 给 assignee 重新执行（非终态）
  | "needs_intervention"// watchdog 达到重试上限，需用户介入（准终态）
  | "cancelled";        // 用户主动放弃，永久终止（终态）

interface StoredGroupTask {
  id: string;
  panelId: string;
  title: string;
  /** 任务描述，包含上下文和验收标准 */
  description: string;
  status: GroupTaskStatus;
  creatorRoleId: string;
  creatorRoleTitle: string;
  assigneeRoleId?: string;
  assigneeRoleTitle?: string;
  /** 父任务 ID（成员提子任务时填写） */
  parentTaskId?: string;
  /**
   * 前置任务 ID 列表，所有前置任务均 done 后才自动触发本任务。
   * 可在创建时填写，也可在执行中通过 block_on / add_dependency 动态追加。
   * 循环依赖检测：add_dependency / block_on 时 DFS 检测，create_task 时新任务无入边不会形成环。
   */
  dependsOnTaskIds: string[];
  /** true = 提交即通过，无需 leader 验收。仅 leader 创建任务时可设置，成员提子任务强制为 false */
  autoApprove: boolean;
  submissionNote?: string;
  reviewNote?: string;
  /**
   * assignee 在执行本任务过程中产生的自然语言输出集合。
   * 每次该 assignee 的 agent session 产生 state=final 且 textLen>0 的文本，
   * app 在 ingest 阶段追加一条记录，用于任务详情页回溯展示。
   */
  textOutputs: GroupTaskTextOutput[];
  /**
   * 当前活跃 dispatch 绑定的 Gateway runId。
   * app 在 dispatch 消息后，通过 ingest 监听 assignee session 的 lifecycle phase=start 写入。
   * 用途：
   *   1. ingest 收到 state=final 时匹配 runId，精确判断"本次 dispatch 是否无响应"
   *   2. textOutputs 追加时关联具体的 run
   * 生命周期：assigned（dispatch 后写入）→ in_progress（保留）→ 任务终态（清空为 null）
   */
  activeRunId?: string | null;
  /** watchdog 已经重试 dispatch 的次数，达到阈值（默认 2）后任务置为 needs_intervention */
  watchdogRetryCount: number;
  /** 最近一次 dispatch 的时间戳，watchdog 据此判断是否超时（5 分钟兜底） */
  lastDispatchAt?: string;
  /** 完整事件日志，用于追溯 */
  events: GroupTaskEvent[];
  createdAt: string;
  updatedAt: string;
}

interface GroupTaskTextOutput {
  id: string;
  /** 角色 ID（通常就是 assigneeRoleId） */
  roleId: string;
  roleTitle: string;
  /** 本次 session 产出的完整文本 */
  text: string;
  /** 关联的 runId，便于按 run 追溯 */
  runId?: string;
  ts: string;
}

interface GroupTaskEvent {
  id: string;
  type: "created" | "assigned" | "started" | "submitted"
      | "approved" | "rejected" | "subtask_requested"
      | "subtask_approved" | "subtask_rejected"
      | "blocked" | "dependency_added"
      | "watchdog_redispatched" | "needs_intervention"
      | "cancelled"
      | "comment";
  actorRoleId: string;
  actorRoleTitle: string;
  note?: string;
  ts: string;
}
```

`groupTasks` 作为顶层集合持久化到 `app-data.json`，不内嵌在 panel 记录内，避免单条 panel 记录过大。

### StoredPanel 新增字段

```typescript
groupMode?: "chat" | "task";  // 默认 "chat"，创建后不可修改
```

---

## Tool：group_task

注册在 customchat 插件内，所有任务操作统一走此 tool，通过 `action` 区分。执行时通过 `sendPortalAppRpc("group_task.action", {...})` 推送给 app（与 `group_route` 相同的 push 模式，不依赖 runtimeSteps）。

| action | 调用方 | 说明 |
|---|---|---|
| `create_task` | leader 或成员 | leader 调用直接进入 assigned；成员调用进入 pending_approval 等 leader 审批 |
| `start_task` | assignee | `assigned → in_progress` |
| `submit_task` | assignee | `in_progress → reviewing`（或直接 `done` 若 autoApprove） |
| `approve_task` | leader | `reviewing → done`，触发依赖此任务的后续任务 |
| `reject_task` | leader | `reviewing → rejected`，重新 dispatch 给 assignee |
| `approve_subtask` | leader | `pending_approval → assigned`，正式进入执行流程 |
| `reject_subtask` | leader | `pending_approval → rejected`，通知提出方 |
| `block_on` | assignee | `in_progress → blocked`，声明阻塞并追加前置依赖，前置完成后自动恢复 `assigned` |
| `add_dependency` | leader 或 assignee | 对未完成任务追加前置依赖，同时做循环检测 |
| `list_tasks` | 任意角色 | 只读，返回当前群**全量**任务列表（含所有状态），对所有成员开放 |
| `get_task` | 任意角色 | 只读，返回单个任务详情（含完整事件日志） |

### create_task 参数

```typescript
{
  action: "create_task",
  panelId: string,
  title: string,
  description: string,          // 包含验收标准
  assigneeTitle: string,         // 执行者角色名
  dependsOnTaskIds?: string[],   // 前置任务 ID 列表，全部完成后才触发
  parentTaskId?: string,         // 父任务 ID（成员提子任务时填写）
  autoApprove?: boolean,         // 默认 false
}
```

---

## 依赖触发逻辑

```
任意任务 T 变为 done
  → 查找所有包含 T.id 在 dependsOnTaskIds 中且 status in (created, blocked) 的任务
  → 对每个候选任务检查：其所有 dependsOnTaskIds 对应的任务是否均为 done
    ├── 是 → status 置为 assigned
    │       → 如果该 assignee 当前无其他 in_progress / blocked 任务 → dispatch 分配消息
    │       → 否则 → 加入 assignee 的 pending dispatch 队列，等当前任务终态后再 dispatch
    └── 否 → 继续等待
```

任何任务到达真正终态（done / cancelled）或 needs_intervention 后，app 检查对应 assignee 的 pending dispatch 队列，取队首任务执行 dispatch。`rejected` 不触发队列推进（退回重做，任务本身仍占用该 assignee 的执行位）。

---

## 动态依赖管理

依赖关系不要求在任务创建时全部声明，可以在执行过程中动态追加。

### block_on（执行中发现阻塞）

assignee 在 `in_progress` 时发现需要等待另一个任务，调用：

```
group_task(block_on, taskId, dependsOnTaskId, note)
```

执行流程：
```
1. app 对 dependsOnTaskId 做循环检测，通过后：
2. 将 dependsOnTaskId 追加到当前任务的 dependsOnTaskIds
3. 当前任务 status: in_progress → blocked
4. dispatch 通知 leader 知晓阻塞情况
5. 当 dependsOnTaskId 对应的任务变为 done 后，触发逻辑同依赖触发逻辑：
   检查所有前置任务均 done → 自动置为 assigned，dispatch 重新分配给 assignee
```

**调用前应先 `list_tasks` 确认**：如果依赖的任务已经是 `done`，则无需 block，直接继续执行即可。

### add_dependency（主动追加依赖）

leader 或 assignee 对**未完成**任务追加前置依赖：

```
group_task(add_dependency, taskId, dependsOnTaskId)
```

限制：
- `taskId` 对应任务状态不能是 `done` 或 `rejected`
- 仍然执行循环依赖检测

---

## 循环依赖检测

**触发时机**：`add_dependency` 和 `block_on`。

`create_task` 创建新任务时不需要检测——新任务尚未存在，不可能有任何已存在任务依赖它，因此加任何前置依赖都不会形成环。

**只有对已存在的任务追加依赖时才可能形成环**（A 依赖 B、B 依赖 C，此时给 C 追加依赖 A）。算法：

```
检测 add_dependency(taskId=X, dependsOnTaskId=Y) 是否成环：
  核心判断：X 是否出现在 Y 的上游链路中
  
  visited = {}
  queue = [Y]
  while queue 不为空:
    current = queue.pop()
    if current == X → 发现循环，拒绝操作
    if current in visited → 跳过（已处理）
    visited.add(current)
    currentTask = allTasks.find(current)
    queue.push(...currentTask.dependsOnTaskIds)
  return false（无循环）
```

发现循环时返回错误，告知具体的循环路径 `X → ... → Y → X`。

---

## autoApprove 逻辑

leader 创建任务时设置 `autoApprove=true`，表示该任务为低风险任务，提交即视为通过：

```
assignee submit_task
  → autoApprove=true → 直接 done，写入 approved 事件，触发依赖链
  → autoApprove=false → reviewing，dispatch 通知 leader 验收
```

### 权限约束

**`autoApprove=true` 只能由 leader 设置**：
- leader 调用 `create_task` 时可传入 `autoApprove=true`
- 成员调用 `create_task`（走 pending_approval 流程）时，若传入 `autoApprove=true`，app 强制改为 `false` 后再进入审批
- leader 在 `approve_subtask` 时可以选择是否将其改为 `autoApprove=true`

这是为了防止成员自己给自己创建一个 autoApprove 任务从而绕过任何验收。

---

## Watchdog 重试与 needs_intervention 处理

角色 session 可能卡死（agent run 正常完成但没有调用任何预期的 `group_task` action），app 无法直接判断"卡死"本身，但可以通过"连续不响应"来反推。

### 检测条件

有两类触发：

**1. 事件驱动检测**（主路径）

当 ingest 收到 assignee 的 agent run 终态（`state=final` / `aborted` / `error`）时：
1. 先用事件中的 `runId` 匹配 `task.activeRunId`——只处理当前活跃 dispatch 对应的 run，忽略历史旧 run
2. 若匹配，且任务仍为 `assigned` 状态（assignee 没有调用 `start_task` 也没有调用 `submit_task`），判定本次 dispatch 无效响应，触发重试流程

> `activeRunId` 在 dispatch 后，通过监听 assignee session 的 `lifecycle phase=start` 事件写入（此时 Gateway 已分配真实 runId）。如果 lifecycle 事件先于任务 dispatch 到达（极端情况），可退回用 `lastDispatchAt` 兜底。

**2. 时间兜底检测**（防御极端情况）

针对 run 完全未启动、消息被丢弃、agent 彻底无响应等极端情况，app 运行一个**任务模式专属的 watchdog 定时器**（独立于聊天模式的 watchdog）：

- 定期扫描所有 `status=assigned` 且有 `lastDispatchAt` 的任务
- 如果 `lastDispatchAt` 距今超过 **5 分钟** 仍未转入 `in_progress`，视同"无响应"，走同样的重试流程
- 同一任务在一个扫描周期内只触发一次（用 `lastDispatchAt` 更新时间去重）

两类检测共用计数器 `watchdogRetryCount` 和重试流程。

### 重试流程

```
1. task.watchdogRetryCount += 1
2. 写入 watchdog_redispatched 事件
3. 如果 watchdogRetryCount < MAX_RETRY（默认 2）
   → 重新 dispatch 原分配消息给 assignee，加上"提醒：上次未响应"前缀
   → task.lastDispatchAt 更新为当前时间
4. 如果 watchdogRetryCount >= MAX_RETRY
   → task.status = needs_intervention
   → 写入 needs_intervention 事件
   → 群整体状态标记为 needs_user（见群组状态章节）
   → 不再自动重试，等用户在前端处理
```

### 用户介入操作

任务进入 `needs_intervention` 后，前端应提供操作入口：
- **重新唤起**：重置 `watchdogRetryCount=0`、清空 `activeRunId`，重新 dispatch 一次，status → `assigned`
- **改派**：修改 `assigneeRoleId` / `assigneeRoleTitle`，重置计数，dispatch 给新 assignee，status → `assigned`
- **放弃**：status → `cancelled`，写入 `cancelled` 事件，附上放弃说明；下游依赖此任务的任务**不会**被自动触发，leader 需手动处理依赖链

> 注意：`cancelled` 是独立终态，语义是"此任务永久终止，不再继续推进"，与 `rejected`（"退回重做"）完全不同。两者绝不能互用。

### in_progress 状态下的卡死

`in_progress` 表示 assignee 已经 `start_task`，但迟迟不 `submit_task`。这种情况 watchdog 不自动处理（执行时间可长可短），由用户在前端观察后手动介入。

---

## 角色删除保护

在任务模式下，`remove_group_role` 和将 `enabled=false` 之前，app 必须检查该角色是否有未完成任务：

```
终态（已结束）：done / cancelled
未完成任务定义：status 不是终态的任务
具体：pending_approval / created / assigned / in_progress / blocked / submitted / reviewing / rejected / needs_intervention
```

存在此类任务时，`remove_group_role` / `update_group_role(enabled=false)` 直接返回错误，提示用户先把任务推进到终态或改派他人，再删除或禁用角色。

群聊模式不受此约束。

---

## 任务创建权限设计

**成员可以提出子任务，但需要 leader 审批。**

这样设计的原因：
- 成员比 leader 更了解自己任务的具体依赖，直接由成员发起上下文最准确
- leader 无需手动转述，减少信息损耗
- 保留 leader 对任务图的最终控制权，防止任务无序扩张

成员提子任务时应填写 `parentTaskId`，便于 leader 在审批时理解上下文，也便于前端按父子关系展示任务树。

### leader 不自派任务

提示词层面约束 leader **不给自己创建任务**。leader 的职责是拆分、分派、验收、处理阻塞，一旦 leader 自己陷入执行任务，就无法及时响应其他成员的 `submitted` 和 `block_on`，形成全群级阻塞。

这条规则不在代码层强制（leader 理论上能自派），仅在 `prompt/group-task-leader.md` 里强调。

---

## 任务可见性

**所有任务对群内所有成员全量可读**，包括 `pending_approval`、`blocked`、`done` 等所有状态的任务。

这是任务模式正常运转的基础：

- 成员在提子任务或声明阻塞前，应先调用 `list_tasks` 查看全量任务列表
  - 依赖的任务已存在 → 直接用其 `taskId` 声明依赖，无需重复创建
  - 依赖的任务已是 `done` → 无需阻塞，直接继续执行
  - 依赖的任务不存在 → 提子任务或向 leader 反馈
- leader 在拆分任务时同样可以先 `list_tasks`，了解当前全局进度再决策
- 提示词应明确要求角色在提出依赖或子任务前必须先查询任务列表，避免重复和冗余

`list_tasks` / `get_task` 为只读操作，对所有角色无权限限制。写操作（create / start / submit / approve 等）仍然按创建权限设计章节的规则执行。

---

## App 自动 dispatch 消息内容

**分配任务：**
```
[任务分配] #{taskId} {title}
描述：{description}
请调用 group_task(start_task) 认领，完成后调用 group_task(submit_task, note=...) 提交。
```

**任务退回：**
```
[任务退回] #{taskId} {title}
退回原因：{reviewNote}
请修改后重新调用 group_task(start_task) 认领并再次提交。
```

**验收请求（通知 leader）：**
```
[待验收] #{taskId} {title}
执行者：{assigneeRoleTitle}
提交说明：{submissionNote}
请调用 group_task(approve_task) 或 group_task(reject_task, note=...) 处理。
```

**任务阻塞通知（通知 leader）：**
```
[任务阻塞] #{taskId} {title}
执行者：{assigneeRoleTitle}
阻塞原因：{note}
等待前置任务：#{dependsOnTaskId} {dependsOnTaskTitle}
前置任务完成后将自动恢复分配。
```

**子任务审批请求（通知 leader）：**
```
[子任务待审批] #{taskId} {title}
提出方：{creatorRoleTitle}  父任务：#{parentTaskId}
描述：{description}
请调用 group_task(approve_subtask) 或 group_task(reject_subtask, note=...) 处理。
```

---

## 前端设计

任务模式群组的面板分为**对话区**和**任务看板**两部分，不再沿用群聊模式的消息列表。

### 对话区（用户 ↔ leader）

任务模式下**不再支持 @ 成员**，用户所有输入统一投递给 leader：

- 用户消息：全部视为"向 leader 下达目标或追加指令"
- leader 回复：仅展示 leader 本人的自然语言回复（例如"我把设计任务分给 UI，开发任务分给 RD"）
- **不展示其他成员的 agent 输出**——assignee 在执行任务时的文本输出都进入所属任务的 `textOutputs`，只在任务详情里展示

对话区 UI 近似一个简化的 1:1 chat，用户和 leader 的对话。

### SSE 消息过滤规则（前端独立实现）

任务模式的前端面板有自己独立的 SSE 订阅和过滤逻辑，**不复用群聊模式的 `panel-card.tsx` 消息处理**。

**过滤规则（对话区）：**

| 消息来源 | 是否展示 | 说明 |
|---|---|---|
| user role 消息 | ✅ 展示 | 用户 → leader 的输入 |
| assistant role + `groupRoleId === leaderRoleId` | ✅ 展示 | leader 本人的自然语言回复 |
| assistant role + `groupRoleId` ≠ leaderRoleId | ❌ 过滤 | 其他成员的 agent session 输出——**不进入对话区**，而是由后端 ingest 追加到所属任务的 `textOutputs`，前端在任务详情里展示 |
| system role 消息 | ❌ 过滤 | 任务模式 app 不再向对话区插 system 提示 |
| `isBridgeDeliveryMessage` 壳消息 | ❌ 过滤 | 同群聊模式，由任务模式自己的 helper 独立实现（不复用 `components/chat-helpers.tsx`） |

**任务看板刷新：**

- 任务列表**不走消息 SSE**，改用独立的 `panels/[panelId]/group-tasks/stream` SSE 端点（或 `panel:update` 事件中附带 `groupTasks` 快照）
- `group_task.*` RPC handler 处理完毕后调用 `refreshGroupTasks(panelId)` 推送最新任务列表，前端据此重新渲染看板
- `textOutputs` 变更一同在此端点推送，任务详情打开时实时刷新

**实现位置：**

- `components/task-mode/task-mode-panel-card.tsx`：任务模式顶层面板，**独立订阅 SSE**，独立维护状态
- `components/task-mode/task-mode-conversation.tsx`：对话区，应用上述过滤规则
- `components/task-mode/task-mode-board.tsx`：任务看板，订阅任务 stream

**不允许的做法：**

- ❌ 在 `components/panel-card.tsx` 里加 `if (panel.groupMode === "task")` 分支
- ❌ 在 `components/chat-helpers.tsx` / `message-list.tsx` 里加任务模式过滤
- ❌ 在聊天模式的 SSE event handler 里塞任务模式专属字段

这些需求一律通过独立文件 + 入口分流实现。

### 任务看板

- **顶部**：群组名称 + 整体进度（X / N 完成）+ 群级状态徽标（见"群组状态聚合"章节）
- **任务列表**：按依赖关系排列，每个任务卡片显示状态、执行者、更新时间
- **任务卡片展开**：
  - 描述、验收标准、提交说明、验收意见
  - 完整事件日志（时间线）
  - **`textOutputs` 列表**：assignee 每次 session 的自然语言输出，按时间排列，便于回溯
- **依赖视图**：任务节点 + 连线，节点颜色对应状态，箭头表示依赖方向
- **needs_intervention 任务操作区**：重新唤起 / 改派 / 放弃

### 群组状态聚合

任务模式下，群级状态由任务列表派生，不再由 leader 手动维护（`manage_group_plan` 在任务模式下不生效）。

按以下优先级从高到低依次判断（满足则取该状态，不再往下）：

| 优先级 | 群状态 | 派生条件 |
|---|---|---|
| 1（最高） | `needs_user` | 有任意 `needs_intervention` 任务 |
| 2 | `blocked` | 有 `blocked` 任务，且无 `in_progress` 任务 |
| 3 | `in_progress` | 有至少一个 `assigned` / `in_progress` / `submitted` / `reviewing` 任务 |
| 4 | `waiting_approval` | 有 `pending_approval` 任务（等 leader 审批子任务），且无更高优先级状态 |
| 5 | `waiting_dependency` | 仅有 `created` 任务（等前置任务完成），无更高优先级状态 |
| 6（最低） | `idle` | 无任何任务，或全部任务均为 `done` / `cancelled` |

- `needs_user` 在前端顶部用显眼颜色提示用户介入
- `waiting_approval` / `waiting_dependency` 用次要颜色提示 leader 有待处理事项，避免误认为空闲
- 前端顶部状态徽标按此优先级显示，帮助用户快速感知群组当前最需要关注的事项

### 不再使用的群聊能力

- `group_route` tool：任务模式路由完全由 `group_task` dispatch 控制
- `manage_group_plan` tool：被任务列表替代
- 群任务状态手动切换：改由任务列表派生
- `@ 角色名` 机制：用户输入全部转 leader

---

## 需要改动的代码模块

> ⚠️ **遵循"🔴 架构隔离原则"章节。**
> 所有任务模式的核心逻辑、UI、SSE、RPC handler 都放在独立目录。
> 对现有文件的改动严格控制在"入口分流"和"在共享类型上追加字段"两类，**不允许在现有函数体内加 `if (groupMode === "task")` 分支**。

### 新增目录与文件（全部是任务模式独立代码）

**后端（`lib/task-mode/`）：**

| 文件 | 说明 |
|---|---|
| `lib/task-mode/types.ts` | 任务模式专属类型：`StoredGroupTask`、`GroupTaskEvent`、`GroupTaskStatus`、`GroupTaskTextOutput`、`GroupTaskView`、群级聚合状态等 |
| `lib/task-mode/store.ts` | 任务 CRUD、事件 append、pending dispatch 队列、群级状态派生；面板删除时清理；角色删除前未完成任务检查 |
| `lib/task-mode/app-rpc-handlers.ts` | `group_task.*` 所有 RPC handler：状态机转换、依赖触发、同 assignee 串行化、循环检测、autoApprove 权限约束 |
| `lib/task-mode/ingest.ts` | 任务模式独立 ingest：`state=final` 不走聊天路由；文本追加到 `task.textOutputs`；检测无响应触发 watchdog 重试 |
| `lib/task-mode/watchdog.ts` | 任务模式专属 watchdog 定时器（独立于聊天模式 watchdog）：5 分钟兜底扫描 + 重试 + `needs_intervention` |
| `lib/task-mode/dispatch.ts` | 任务 dispatch 消息构造（分配 / 退回 / 验收请求 / 阻塞通知 / 子任务审批请求）及对 Gateway 的推送封装 |
| `lib/task-mode/cycle-detect.ts` | 循环依赖检测（DFS），仅在 `add_dependency` / `block_on` 时调用 |
| `lib/task-mode/sse.ts` | 任务模式独立 SSE 推送：任务列表变更、textOutputs 变更 |

**前端（`components/task-mode/`）：**

| 文件 | 说明 |
|---|---|
| `components/task-mode/task-mode-panel-card.tsx` | 任务模式顶层面板，独立订阅 SSE，独立状态管理 |
| `components/task-mode/task-mode-conversation.tsx` | 对话区（用户 ↔ leader），按本文档过滤规则过滤消息 |
| `components/task-mode/task-mode-board.tsx` | 任务看板主组件 |
| `components/task-mode/task-mode-task-card.tsx` | 单个任务卡片（含事件日志和 textOutputs） |
| `components/task-mode/task-mode-dependency-graph.tsx` | 依赖关系图可视化（后期） |
| `components/task-mode/task-mode-helpers.ts` | 任务模式专属 helper（消息过滤、状态派生等），不复用 `components/chat-helpers.tsx` |

**API（`app/api/panels/[panelId]/group-tasks/`）：**

| 文件 | 说明 |
|---|---|
| `app/api/panels/[panelId]/group-tasks/route.ts` | GET 任务列表 |
| `app/api/panels/[panelId]/group-tasks/[taskId]/route.ts` | 单个任务详情 + 用户介入操作（重新唤起 / 改派 / 放弃） |
| `app/api/panels/[panelId]/group-tasks/stream/route.ts` | 任务模式专属 SSE 端点，推送任务列表和 textOutputs 变更 |

**Plugin（`plugins/customchat/`）：**

| 文件 | 说明 |
|---|---|
| `plugins/customchat/group-task-tool.ts` | `group_task` tool schema + execute（通过 `sendPortalAppRpc` 推送到 app），完全独立于 `group_route` tool |

**提示词（`prompt/`）：**

| 文件 | 说明 |
|---|---|
| `prompt/group-task-leader.md` | 任务模式 leader 注入提示词（拆分、分派、验收、不自派、用 `group_task` tool） |
| `prompt/group-task-member.md` | 任务模式成员注入提示词（先 `list_tasks` 再决策、用 `group_task` tool、不 @ 其他成员） |

### 对现有文件的改动（严格限定在"入口分流"和"共享类型字段追加"）

| 文件 | 允许的改动 | 禁止的改动 |
|---|---|---|
| `lib/types.ts` | `StoredPanel` / `PanelView` 追加 `groupMode?: "chat" \| "task"` 字段；`AppData` 追加 `groupTasks: StoredGroupTask[]` 字段（类型从 `lib/task-mode/types.ts` re-export） | 不新增任何聊天模式函数会读到的任务模式专属逻辑类型 |
| `lib/store.ts` | 仅**序列化层**改动：`loadAppData` / `saveAppData` 读写 `groupTasks` 字段；`deletePanel` 末尾调用 `lib/task-mode/store.ts` 的清理函数（一行 import + 一行调用） | ❌ 不在 store.ts 里实现任何任务业务逻辑；任务 CRUD 全部放到 `lib/task-mode/store.ts` |
| `lib/customchat-ingest.ts` | **入口顶部分流**：收到事件后先读 panel.groupMode，若为 `"task"` 直接 `return taskModeIngest(event)`，后续聊天代码一行不碰 | ❌ 不在现有聊天处理流程里插任何任务模式 if/else |
| `lib/customchat-app-rpc.ts` | **注册时分流**：在 handler 注册映射表中加一组 `group_task.*` key，映射到 `lib/task-mode/app-rpc-handlers.ts` 导出的函数 | ❌ 不在现有 handler 体内加任务模式分支 |
| `plugins/customchat/index.ts` | 注册 `group_task` tool（一行 import + 一行 `tools.register`） | ❌ 不修改 `group_route` tool 代码 |
| `components/panel-card.tsx` | **顶层分流**：函数体第一行判断 `if (panel.kind === "group" && panel.groupMode === "task") return <TaskModePanelCard panel={panel} />;`，其他代码保持原样 | ❌ 不在函数中段或 JSX 内部加 groupMode 分支 |
| `components/create-group-dialog.tsx` | 在表单里加 `groupMode` 单选（群聊 / 任务），作为创建群组 API 的新参数 | ❌ 不改动现有群聊创建成功后的跳转逻辑 |
| `components/manage-group-roles-dialog.tsx` | 删除/禁用角色提交前，若 `panel.groupMode === "task"`，先调用任务模式的校验 API 检查未完成任务；失败则弹窗提示 | ❌ 不改动群聊模式下的删除行为 |

**复用策略澄清：**

- `nowIso`、`mutateData`、`getPanelRecordForUser`、`resolveUser` 这类**纯基础设施函数**可以直接 import 使用
- 凡是需要"加参数 / 加可选字段 / 加分支"才能兼容任务模式的函数，一律在 `lib/task-mode/` 下**复制一份独立维护**
- 当出现"看起来能复用但要改一下"的诱惑时，**默认选择复制独立实现**

**审查 Checklist：**

- [ ] 所有新增业务逻辑代码是否在 `lib/task-mode/` 或 `components/task-mode/` 下？
- [ ] 对现有文件的 diff 是否都只做了"入口分流"或"序列化字段追加"？
- [ ] 是否向任何现有函数体内加了 `if (groupMode === "task")` 分支？（必须为 No）
- [ ] 任务模式的 SSE / ingest / RPC 路径是否与聊天模式完全隔离？

---

## 实现优先级

1. 数据模型 + store CRUD（`types.ts` + `store.ts`，含 `textOutputs`、`watchdogRetryCount`）
2. `group_task` tool + RPC handlers（最小可用：create / start / submit / approve / reject）
3. 依赖触发逻辑 + 同 assignee 串行化队列
4. 循环依赖检测（在 `add_dependency` / `block_on` 时触发）
5. 动态依赖管理：`block_on` + `add_dependency`
6. 成员提子任务 + leader 审批流程（`approve_subtask` / `reject_subtask`）
7. autoApprove 权限约束（仅 leader 可设）
8. 创建群组时模式选择
9. 前端任务看板（基础版：列表 + 状态 + 对话区）
10. assignee 文本输出 `textOutputs` 在 ingest 追加
11. 提示词注入（`prompt/group-task-*.md`，含"先 list_tasks 再决策"、"leader 不自派"规则）
12. Watchdog 重试 + needs_intervention 状态 + 用户介入 UI
13. 角色删除保护（未完成任务时拒绝删除/禁用）
14. 任务依赖图可视化

---

## 重启恢复策略

app 进程重启后，持久化到 `app-data.json` 的任务数据（status、lastDispatchAt、watchdogRetryCount、assigneeRoleId 等）完整保留，不会丢失。需要重建的是两类**纯内存运行时状态**：

### 1. pending dispatch 队列重建

队列不持久化，重启后由 `lib/task-mode/store.ts` 在模块加载时自动重建：

```
扫描所有 groupTasks，按 panelId × assigneeRoleId 分组
对每组：
  1. 找出该 assignee 当前 status=in_progress / blocked 的任务（至多一个）
  2. 将该 assignee 所有 status=assigned 且不是该任务的任务，按 createdAt 排序，加入 pending 队列
  3. 若该 assignee 没有 in_progress/blocked 任务，取队首任务重新 dispatch
     （dispatch 前先检查 lastDispatchAt 是否在 5 分钟内，避免重复 dispatch）
```

### 2. watchdog 定时器重启

`lib/task-mode/watchdog.ts` 在模块初始化时启动定时器。重启后首次扫描时：

- 所有 `status=assigned` 且 `lastDispatchAt` 距今超过 5 分钟的任务，立即触发 watchdog 重试流程
- `activeRunId` 在重启后视为过期，清空为 `null`（对应 run 已不在内存中）；后续 dispatch 会写入新的 `activeRunId`

### 3. 持久化字段与可重建字段对照

| 字段 | 是否持久化 | 重启后处理 |
|---|---|---|
| `status` | ✅ 持久化 | 直接读取，无需处理 |
| `lastDispatchAt` | ✅ 持久化 | 直接用于 watchdog 超时判断 |
| `watchdogRetryCount` | ✅ 持久化 | 直接读取，计数不丢失 |
| `assigneeRoleId` | ✅ 持久化 | 直接用于队列分组 |
| `activeRunId` | ✅ 持久化（但需清空） | 重启后清空为 `null`，等新 dispatch 写入 |
| pending dispatch 队列 | ❌ 纯内存 | 按上述规则从任务数据重建 |
| watchdog 定时器 | ❌ 纯内存 | 模块加载时重新启动 |

---

## 与群聊模式的边界

- 两种模式仅共用**最低限度的共享物**：`StoredPanel` / `StoredGroupRole` 的结构定义、群组创建/删除的基础设施函数（`mutateData`、面板加载/权限校验等）
- 运行时**完全分流**：消息路由、ingest 处理、RPC handler、SSE 推送、前端渲染均在**入口点**根据 `groupMode` 一次性分叉到独立模块，之后两条路径互不相见
- 任务模式不使用 `group_route` tool，路由完全由 `group_task` tool 的 app 侧 dispatch 控制
- 任务模式的角色仍然使用 `manage_group_memory` 记忆工具（跨任务共享上下文）
- **代码组织边界**：`lib/task-mode/*` 和 `components/task-mode/*` 是任务模式专属领土，聊天模式代码不 import 这两个目录下的任何东西，反之亦然（除共享基础设施）

---

## 实现进度

> 图例：✅ 已完成　⚠️ 部分实现/有偏差　❌ 未实现

### 一、数据模型与持久化

| 功能点 | 状态 | 备注 |
|---|---|---|
| `StoredGroupTask` 完整类型定义（含 `textOutputs`、`watchdogRetryCount`、`activeRunId` 等） | ✅ | `lib/task-mode/types.ts` |
| `groupTasks` 持久化到 `app-data.json` | ✅ | `lib/store.ts` 序列化层 |
| `StoredPanel.groupMode` 字段 | ✅ | `lib/types.ts` |
| 任务 CRUD（create / get / update / list） | ✅ | `lib/task-mode/store.ts` |
| 事件日志 append | ✅ | `appendTaskEvent` |
| Pending dispatch 内存队列（enqueue / dequeue / requeue） | ✅ | `lib/task-mode/store.ts` |
| `rebuildPendingDispatchQueues`（重启后重建队列） | ✅ | `lib/task-mode/store.ts` |
| `clearAllActiveRunIds`（重启后清空 activeRunId） | ✅ | `lib/task-mode/store.ts` |
| `readAllGroupTasks`（跨面板全量读取，供 watchdog 使用） | ✅ | `lib/store.ts` |

### 二、group_task Tool 与 RPC Handler

| 功能点 | 状态 | 备注 |
|---|---|---|
| `group_task` tool schema 注册（插件侧） | ✅ | `plugins/customchat/group-task-tool.ts` |
| `create_task`（leader 直接 assigned；成员走 pending_approval） | ✅ | `app-rpc-handlers.ts` |
| `start_task`（assigned / rejected → in_progress） | ✅ | |
| `submit_task`（in_progress → reviewing 或 done） | ✅ | |
| `approve_task`（reviewing → done，触发依赖链） | ✅ | |
| `reject_task`（reviewing → rejected，退回队首） | ✅ | |
| `approve_subtask`（pending_approval → assigned） | ✅ | |
| `reject_subtask`（pending_approval → cancelled，通知 creator） | ✅ | |
| `block_on`（in_progress → blocked，追加依赖，通知 leader） | ✅ | |
| `add_dependency`（对未完成任务动态追加前置依赖） | ✅ | |
| `list_tasks`（只读，全量返回） | ✅ | |
| `get_task`（只读，单任务详情） | ✅ | |
| `cancel_task`（任意非终态 → cancelled） | ✅ | |

### 三、任务调度逻辑

| 功能点 | 状态 | 备注 |
|---|---|---|
| 任务 done 后自动触发下游依赖任务（`triggerDependentTasks`） | ✅ | |
| 同 assignee 串行化：`hasActiveTask` 检查 + pending 队列 | ✅ | |
| 当前任务终态后自动 flush 队首任务（`flushPendingDispatch`） | ✅ | |
| `rejected` 不释放队列，退回任务排在队首 | ✅ | |
| `autoApprove=true` 仅 leader 可设，成员调用强制 false | ✅ | |
| `approve_subtask` 时 leader 可追加设置 `autoApprove=true` | ✅ | |
| 循环依赖检测（BFS + 父指针路径回溯，`block_on` / `add_dependency` 时触发） | ✅ | `lib/task-mode/cycle-detect.ts` |

### 四、消息 Dispatch 与提示词注入

| 功能点 | 状态 | 备注 |
|---|---|---|
| `dispatchTaskMessage` 封装（`sendInboundToPlugin` + `recordTaskDispatch`） | ✅ | `lib/task-mode/dispatch.ts` |
| 所有 dispatch 调用传入 `isLeader` / `roleTitle` 参数 | ✅ | `app-rpc-handlers.ts` 全部 10 处调用 |
| 首次 dispatch 自动注入任务模式系统提示词 | ✅ | `dispatch.ts` `isTaskModeFirstDispatch` 逻辑 |
| `group-task-leader.md` 提示词（含 `{{MEMBERS_LIST}}`） | ✅ | `prompt/group-task-leader.md` |
| `group-task-member.md` 提示词（含 `{{MEMBERS_LIST}}`） | ✅ | `prompt/group-task-member.md` |
| 用户消息直接投递给 leader（跳过 group_route） | ✅ | `lib/task-mode/group-task-message.ts` |
| 分配 / 退回 / 验收请求 / 阻塞通知 / 子任务审批请求 消息模板 | ✅ | `dispatch.ts` buildXxx 系列函数 |
| Watchdog 重试消息模板 | ✅ | `buildWatchdogRetryMessage` |

### 五、Ingest 处理

| 功能点 | 状态 | 备注 |
|---|---|---|
| `customchat-ingest.ts` 入口分流（任务模式交给独立模块） | ✅ | |
| leader 回复 → 存消息 + 发 SSE，展示在对话区 | ✅ | `lib/task-mode/ingest.ts` |
| 非 leader 成员回复 → 追加到任务 `textOutputs`（`state=final` 时） | ✅ | `appendTaskTextOutputForRole` |
| 事件驱动 watchdog：`state=final` 且任务仍为 `assigned` → 触发重试 | ✅ | `checkWatchdog` |
| `activeRunId` 精确匹配 + 退回用角色+状态猜测 | ✅ | |

### 六、Watchdog 与用户介入

| 功能点 | 状态 | 备注 |
|---|---|---|
| 任务模式专属 watchdog 定时器（每 60 秒扫描） | ✅ | `lib/task-mode/watchdog.ts` |
| 5 分钟兜底：`lastDispatchAt` 超时触发重试 | ✅ | `scanAndRetry` |
| 重试计数 + 达到 MAX_RETRY(2) 置为 `needs_intervention` | ✅ | `watchdogRedispatch` |
| `instrumentation.ts` 启动钩子（重建队列 + 清 activeRunId + 启动 watchdog） | ✅ | `instrumentation.ts` |
| 用户介入 API（`POST /group-tasks/[taskId]`：cancel / redispatch / reset_watchdog） | ✅ | |
| 用户介入 UI（任务详情里的"重新分配"和"取消任务"按钮） | ✅ | `task-mode-board.tsx` |
| **改派（修改 assignee 后重新 dispatch）** | ❌ | 介入 API 只支持原 assignee 重新 dispatch，未实现改派给其他角色 |
| `in_progress` 卡死的人工介入提示 | ⚠️ | 有取消按钮，但没有专门针对"执行中超时"的前端提示 |

### 七、前端 UI

| 功能点 | 状态 | 备注 |
|---|---|---|
| `components/panel-card.tsx` 顶层分流（`groupMode=task` → `TaskModePanelCard`） | ✅ | |
| `task-mode-panel-card.tsx`（顶层容器，SSE 订阅，双栏布局） | ✅ | |
| `task-mode-conversation.tsx`（对话区，消息过滤，composer） | ✅ | |
| `task-mode-board.tsx`（任务看板，状态分组，详情面板） | ✅ | |
| 对话区 SSE 过滤规则（只展示 user + leader，过滤壳消息） | ✅ | |
| 任务看板刷新 | ✅ | 独立 SSE 端点 `/group-tasks/stream`；store 层所有写入函数（`updateGroupTaskStatus`、`updateGroupTaskField`、`appendTaskTextOutput`、`appendTaskEvent`、`addTaskDependency`、`recordTaskDispatch`、`createGroupTask`）完成后均调用 `publishGroupTasksUpdate(panelId)`，前端实时收到 `tasks_updated` 事件后重新拉取看板 |
| 角色管理入口（添加角色 / 管理角色） | ✅ | `task-mode-panel-card.tsx` header |
| 群组状态徽标（`GroupTaskModeState` 六级） | ✅ | |
| 任务卡片（状态、执行者、前置数量、watchdog 警告） | ✅ | |
| 任务详情（描述、提交说明、审核意见、textOutputs、事件日志） | ✅ | |
| `needs_intervention` 操作区（重新分配、取消任务） | ✅ | |
| **`task-mode-helpers.ts`（独立 helper 文件）** | ❌ | 相关逻辑内联在各组件中，未按设计单独提取为独立文件 |
| **`task-mode-task-card.tsx`（独立 TaskCard 组件文件）** | ❌ | 内联在 `task-mode-board.tsx` 中，未单独拆文件 |
| **任务依赖图可视化（`task-mode-dependency-graph.tsx`）** | ❌ | 设计标注为"后期"，未实现 |

### 八、API 路由

| 功能点 | 状态 | 备注 |
|---|---|---|
| `GET /api/panels/[panelId]/group-tasks`（任务列表） | ✅ | |
| `POST /api/panels/[panelId]/group-tasks/[taskId]`（用户介入操作） | ✅ | |
| **`GET /api/panels/[panelId]/group-tasks/stream`（任务变更 SSE 端点）** | ❌ | 设计要求独立 SSE 端点，未实现；前端用轮询替代 |

### 九、架构隔离

| 功能点 | 状态 | 备注 |
|---|---|---|
| `lib/task-mode/*` 独立目录 | ✅ | |
| `components/task-mode/*` 独立目录 | ✅ | |
| `customchat-ingest.ts` 入口分流（不在函数体内加 if 分支） | ✅ | |
| `customchat-app-rpc.ts` group_task 分流到独立 handler | ✅ | |
| `plugins/customchat/index.ts` 注册 `group_task` tool | ✅ | |
| 创建群组时 `groupMode` 选择（群聊 / 任务） | ✅ | `create-group-dialog.tsx` |

### 十、角色保护

| 功能点 | 状态 | 备注 |
|---|---|---|
| **任务模式下删除/禁用角色前检查未完成任务** | ❌ | `handleRemoveGroupRole`（`customchat-app-rpc.ts`）和 `manage-group-roles-dialog.tsx` 均未加保护逻辑 |

### 十一、重启恢复

| 功能点 | 状态 | 备注 |
|---|---|---|
| 重启后重建 pending dispatch 队列 | ✅ | `instrumentation.ts` → `rebuildPendingDispatchQueues` |
| 重启后清空 `activeRunId` | ✅ | `instrumentation.ts` → `clearAllActiveRunIds` |
| 重启后启动 watchdog 定时器 | ✅ | `instrumentation.ts` → `startTaskModeWatchdog` |
| **重启后对遗漏的 `assigned` 任务重新 dispatch** | ❌ | 设计文档要求重建队列时，若 assignee 无活跃任务应重新 dispatch 队首任务；`instrumentation.ts` 只重建了队列，未触发 dispatch |

---

### 未实现功能汇总（待补）

| 优先级 | 功能 | 说明 |
|---|---|---|
| P1 | 角色删除/禁用保护 | `customchat-app-rpc.ts` `handleRemoveGroupRole` + `manage-group-roles-dialog.tsx` 需检查未完成任务 |
| P1 | 重启后对遗漏任务重新 dispatch | `instrumentation.ts` 重建队列后，若 assignee 无 in_progress/blocked 任务，应立即 dispatch 队首 assigned 任务 |
| P1 | 用户介入"改派"操作 | 修改 `assigneeRoleId` + 重新 dispatch，API 和 UI 均需新增 |
| ~~P2~~ | ~~任务看板专属 SSE 端点~~ | ✅ 已完成 |
| P3 | `task-mode-helpers.ts` 独立 helper 文件 | 将内联逻辑提取为独立文件 |
| P3 | `task-mode-task-card.tsx` 独立组件文件 | 从 board.tsx 中拆出 |
| 后期 | 任务依赖图可视化 | `task-mode-dependency-graph.tsx`，节点 + 连线，颜色对应状态 |

