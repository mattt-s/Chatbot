# Task Mode Plan Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured planning phase to task mode where Leader collects requirements via multi-turn conversation, fills a `TaskModePlan` document field-by-field via `task_plan` tool, and execution only starts after the user explicitly confirms the plan.

**Architecture:** Same Leader Agent + injected planning-phase system prompt (`group-task-plan.md`). Leader calls `task_plan(update_field)` after each user answer; app persists and pushes `plan_updated` SSE; frontend renders a real-time Plan preview panel. On user confirmation (`POST /task-plan/confirm`), app marks plan confirmed, sends Leader a message with the full plan + execution-phase prompt, and frontend switches to the task board. `handleCreateTask` gate rejects any `create_task` call while plan is not confirmed.

**Tech Stack:** Next.js 15, TypeScript, Server-Sent Events, in-process pub/sub (global singleton pattern matching existing `lib/task-mode/sse.ts`), existing plugin RPC pattern (`sendPortalAppRpc` → `customchat-app-rpc.ts`), React + Tailwind.

**Naming note:** Existing `GroupPlan` / `group_plan.*` / `manage_group_plan` tool belong to **chat mode** (summary + items list). Task mode planning uses `TaskModePlan` / `task_plan.*` / `task_plan` tool — completely separate namespacing.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/task-mode/types.ts` | Modify | Add `TaskModePlan` interface |
| `lib/store.ts` | Modify | Add `taskModePlans` to `AppData`; add `mutateTaskModePlans` helper |
| `lib/task-mode/plan-store.ts` | Create | TaskModePlan CRUD + `publishPlanUpdate` |
| `lib/task-mode/sse.ts` | Modify | Add `publishGroupPlanUpdate` / `subscribeGroupPlanUpdate` |
| `app/api/panels/[panelId]/stream/route.ts` | Modify | Subscribe to plan updates, push `plan_updated` SSE event |
| `app/api/panels/[panelId]/task-plan/route.ts` | Create | `GET` — return current TaskModePlan |
| `app/api/panels/[panelId]/task-plan/confirm/route.ts` | Create | `POST` — confirm plan, send execution prompt to Leader |
| `plugins/customchat/task-plan-tool.ts` | Create | `task_plan` plugin tool schema + execute |
| `plugins/customchat/index.ts` | Modify | Register `task_plan` tool |
| `lib/task-mode/plan-rpc-handlers.ts` | Create | `handleTaskPlanUpdateField` RPC handler |
| `lib/customchat-app-rpc.ts` | Modify | Route `task_plan.update_field` to new handler |
| `lib/task-mode/app-rpc-handlers.ts` | Modify | Gate `handleCreateTask` on plan confirmed |
| `lib/task-mode/group-task-message.ts` | Modify | Inject planning prompt on first dispatch when plan not confirmed |
| `prompt/group-task-plan.md` | Create | Leader planning-phase system prompt |
| `components/task-mode/task-mode-plan-view.tsx` | Create | Plan preview panel (right column, planning phase) |
| `components/task-mode/task-mode-panel-card.tsx` | Modify | Show plan view vs task board based on plan status; subscribe `plan_updated` SSE |

---

## Task 1: Add `TaskModePlan` type

**Files:**
- Modify: `lib/task-mode/types.ts`

- [ ] **Step 1: Add type to types.ts**

Open `lib/task-mode/types.ts` and append after the last export:

```typescript
// ─────────────────────────────────────────────────────────────
// Task Mode Plan (Planning Phase)
// ─────────────────────────────────────────────────────────────

export type TaskModePlanStatus = "drafting" | "confirmed";

export const TASK_PLAN_FIELDS = [
  "goal",
  "constraints",
  "deliverables",
  "acceptanceCriteria",
  "taskOutline",
] as const;

export type TaskModePlanField = typeof TASK_PLAN_FIELDS[number];

export interface TaskModePlan {
  panelId: string;
  /** 最终目标（一句话版本） */
  goal: string;
  /** 约束条件：技术栈、风格、禁止触碰的边界 */
  constraints: string[];
  /** 交付物清单：以什么形式存在、存在哪里 */
  deliverables: string[];
  /** 验收标准：用户如何判断完成 */
  acceptanceCriteria: string[];
  /** leader 的高层拆分草稿（给用户预览，执行阶段再细化为 Task） */
  taskOutline: string[];
  status: TaskModePlanStatus;
  confirmedAt?: string;
}

export function emptyTaskModePlan(panelId: string): TaskModePlan {
  return {
    panelId,
    goal: "",
    constraints: [],
    deliverables: [],
    acceptanceCriteria: [],
    taskOutline: [],
    status: "drafting",
  };
}
```

- [ ] **Step 2: Verify types compile**

```bash
cd /Users/siyushi/IdeaProjects/Chatbot
npx tsc --noEmit 2>&1 | head -20
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```bash
git add lib/task-mode/types.ts
git commit -m "feat(task-plan): add TaskModePlan type"
```

---

## Task 2: Persist `TaskModePlan` in AppData

**Files:**
- Modify: `lib/store.ts`

- [ ] **Step 1: Add `taskModePlans` to AppData and EMPTY_DATA**

In `lib/store.ts`, find the `AppData` interface (or where `groupTasks` is declared) and add `taskModePlans`:

```typescript
// In AppData interface (lib/types.ts or inline in store.ts — find where groupTasks: StoredGroupTask[] is declared)
taskModePlans?: import("./task-mode/types").TaskModePlan[];
```

Find `EMPTY_DATA` constant and add:
```typescript
taskModePlans: [],
```

Find the `readData` function where `parsed.groupTasks = parsed.groupTasks ?? []` is set and add:
```typescript
parsed.taskModePlans = parsed.taskModePlans ?? [];
```

- [ ] **Step 2: Add `mutateTaskModePlans` helper**

After the existing `mutateGroupTasks` function, add:

```typescript
/**
 * 对 taskModePlans 数组执行变更回调，自动持久化。
 */
export async function mutateTaskModePlans<T = void>(
  callback: (plans: import("./task-mode/types").TaskModePlan[]) => T,
): Promise<T> {
  return mutateData((draft) => {
    draft.taskModePlans = draft.taskModePlans ?? [];
    return callback(draft.taskModePlans) as T;
  });
}

/**
 * 读取指定面板的 TaskModePlan（无则返回 null）。
 */
export async function readTaskModePlan(
  panelId: string,
): Promise<import("./task-mode/types").TaskModePlan | null> {
  const data = await readData();
  return (data.taskModePlans ?? []).find((p) => p.panelId === panelId) ?? null;
}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/store.ts
git commit -m "feat(task-plan): persist TaskModePlan in AppData"
```

---

## Task 3: Create `plan-store.ts`

**Files:**
- Create: `lib/task-mode/plan-store.ts`

- [ ] **Step 1: Create file**

```typescript
/**
 * @module task-mode/plan-store
 * TaskModePlan CRUD。所有写操作在持久化后触发 publishGroupPlanUpdate。
 */
import "server-only";

import { createLogger } from "@/lib/logger";
import { mutateTaskModePlans, readTaskModePlan } from "@/lib/store";
import {
  emptyTaskModePlan,
  type TaskModePlan,
  type TaskModePlanField,
} from "@/lib/task-mode/types";
import { publishGroupPlanUpdate } from "@/lib/task-mode/sse";
import { nowIso } from "@/lib/utils";

const log = createLogger("task-mode:plan-store");

/** 获取面板的 Plan，不存在则返回 null。 */
export async function getTaskModePlan(panelId: string): Promise<TaskModePlan | null> {
  return readTaskModePlan(panelId);
}

/** 获取面板的 Plan，不存在则自动创建并持久化一个空 Plan。 */
export async function getOrCreateTaskModePlan(panelId: string): Promise<TaskModePlan> {
  const existing = await readTaskModePlan(panelId);
  if (existing) return existing;

  const plan = emptyTaskModePlan(panelId);
  await mutateTaskModePlans((plans) => {
    plans.push(plan);
  });

  log.debug("getOrCreateTaskModePlan.created", { panelId });
  return plan;
}

/**
 * 更新 Plan 的某个字段。
 * - goal: string（直接替换）
 * - constraints / deliverables / acceptanceCriteria / taskOutline: string[]（直接替换）
 */
export async function updateTaskModePlanField(
  panelId: string,
  field: TaskModePlanField,
  value: string | string[],
): Promise<TaskModePlan> {
  const updated = await mutateTaskModePlans((plans) => {
    let plan = plans.find((p) => p.panelId === panelId);
    if (!plan) {
      plan = emptyTaskModePlan(panelId);
      plans.push(plan);
    }

    if (field === "goal") {
      plan.goal = typeof value === "string" ? value : value.join("\n");
    } else {
      const arr = Array.isArray(value)
        ? value
        : [value].filter(Boolean);
      (plan as Record<string, unknown>)[field] = arr;
    }

    return structuredClone(plan);
  });

  log.debug("updateTaskModePlanField", { panelId, field });
  publishGroupPlanUpdate(panelId);
  return updated;
}

/** 将 Plan 标记为 confirmed，阻止后续修改并解锁 create_task。 */
export async function confirmTaskModePlan(panelId: string): Promise<TaskModePlan> {
  const updated = await mutateTaskModePlans((plans) => {
    let plan = plans.find((p) => p.panelId === panelId);
    if (!plan) {
      plan = emptyTaskModePlan(panelId);
      plans.push(plan);
    }
    plan.status = "confirmed";
    plan.confirmedAt = nowIso();
    return structuredClone(plan);
  });

  log.debug("confirmTaskModePlan", { panelId });
  publishGroupPlanUpdate(panelId);
  return updated;
}
```

- [ ] **Step 2: Add `nowIso` check — if it doesn't exist in utils, use `new Date().toISOString()`**

```bash
grep -n "export.*nowIso" /Users/siyushi/IdeaProjects/Chatbot/lib/utils.ts
```

If not found, replace `nowIso()` with `new Date().toISOString()` in plan-store.ts.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/task-mode/plan-store.ts
git commit -m "feat(task-plan): add plan-store CRUD"
```

---

## Task 4: Add `plan_updated` to SSE module

**Files:**
- Modify: `lib/task-mode/sse.ts`
- Modify: `app/api/panels/[panelId]/stream/route.ts`

- [ ] **Step 1: Add plan pub/sub to sse.ts**

Append to `lib/task-mode/sse.ts`:

```typescript
// ─── Plan 更新通知 ───────────────────────────────────────────

type PlanUpdateListener = (panelId: string) => void;

declare global {
  var __taskModePlanUpdateListeners: Set<PlanUpdateListener> | undefined;
}

function planListeners(): Set<PlanUpdateListener> {
  if (!globalThis.__taskModePlanUpdateListeners) {
    globalThis.__taskModePlanUpdateListeners = new Set();
  }
  return globalThis.__taskModePlanUpdateListeners;
}

export function publishGroupPlanUpdate(panelId: string) {
  for (const listener of planListeners()) {
    try { listener(panelId); } catch { /* ignore */ }
  }
}

export function subscribeGroupPlanUpdate(listener: PlanUpdateListener): () => void {
  planListeners().add(listener);
  return () => { planListeners().delete(listener); };
}
```

- [ ] **Step 2: Subscribe in main panel SSE route**

In `app/api/panels/[panelId]/stream/route.ts`, find the section where `unsubscribeTasks` is declared and add:

```typescript
let unsubscribePlan: (() => void) | null = null;
```

In the `start(controller)` callback, after `unsubscribeTasks = subscribeGroupTasksUpdate(...)`, add:

```typescript
// Plan 变更通知（规划阶段使用）
const { subscribeGroupPlanUpdate } = await import("@/lib/task-mode/sse");
unsubscribePlan = subscribeGroupPlanUpdate((updatedPanelId) => {
  if (updatedPanelId !== panel.id) return;
  push("plan_updated", { panelId: panel.id });
});
```

In the `cancel()` callback, add cleanup:

```typescript
if (unsubscribePlan) { unsubscribePlan(); unsubscribePlan = null; }
```

Note: The `import()` inside `start()` is fine since `start` is `async` and SSE routes already use dynamic imports via the module system. If linting complains, move the import to the top of the file.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add lib/task-mode/sse.ts app/api/panels/\[panelId\]/stream/route.ts
git commit -m "feat(task-plan): add plan_updated SSE event"
```

---

## Task 5: Plan read API

**Files:**
- Create: `app/api/panels/[panelId]/task-plan/route.ts`

- [ ] **Step 1: Create file**

```typescript
/**
 * @file GET /api/panels/[panelId]/task-plan
 * 返回当前面板的 TaskModePlan（无则返回空 Plan）。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser } from "@/lib/store";
import { getOrCreateTaskModePlan } from "@/lib/task-mode/plan-store";

type RouteContext = { params: Promise<{ panelId: string }> };

export async function GET(_req: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) return NextResponse.json({ error: "Panel not found." }, { status: 404 });

  const plan = await getOrCreateTaskModePlan(panelId);
  return NextResponse.json({ plan });
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add "app/api/panels/[panelId]/task-plan/route.ts"
git commit -m "feat(task-plan): add GET /task-plan API"
```

---

## Task 6: Create `task_plan` plugin tool

**Files:**
- Create: `plugins/customchat/task-plan-tool.ts`
- Modify: `plugins/customchat/index.ts`

- [ ] **Step 1: Create task-plan-tool.ts**

```typescript
import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const TASK_PLAN_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["update_field"],
      description: "要执行的规划动作。目前仅支持 update_field（更新计划某个字段）。",
    },
    panelId: {
      type: "string",
      description: "当前群组面板 ID（必须是真实 panelId，UUID 格式）。",
    },
    field: {
      type: "string",
      enum: ["goal", "constraints", "deliverables", "acceptanceCriteria", "taskOutline"],
      description: [
        "要更新的字段：",
        "- goal：最终目标（string）",
        "- constraints：约束条件（string[]，完整替换）",
        "- deliverables：交付物（string[]，完整替换）",
        "- acceptanceCriteria：验收标准（string[]，完整替换）",
        "- taskOutline：高层任务草稿（string[]，完整替换）",
      ].join("\n"),
    },
    value: {
      description: "新值。goal 为 string，其余为 string[]。",
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ],
    },
  },
  required: ["action", "panelId", "field", "value"],
} as const;

function jsonToolResult(payload: unknown): CustomChatToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function registerCustomChatTaskPlanTool(api: CustomChatToolApi) {
  api.registerTool({
    name: "task_plan",
    description: [
      "在任务模式规划阶段更新群组计划字段。",
      "每次用户回答一个问题后，立即调用此工具将答案写入对应字段。",
      "所有字段填写完毕并向用户确认后，告知用户点击「确认计划」按钮进入执行阶段。",
      "注意：规划阶段不得调用 group_task（create_task 会被系统拒绝）。",
    ].join(" "),
    inputSchema: TASK_PLAN_TOOL_SCHEMA,
    execute: async (params: Record<string, unknown>): Promise<CustomChatToolResult> => {
      const action = params.action as string;
      if (action !== "update_field") {
        return jsonToolResult({ ok: false, error: `Unknown action: ${action}` });
      }
      const result = await sendPortalAppRpc("task_plan.update_field", {
        panelId: params.panelId,
        field: params.field,
        value: params.value,
      });
      return jsonToolResult(result);
    },
  });
}
```

- [ ] **Step 2: Register in index.ts**

In `plugins/customchat/index.ts`, add import:

```typescript
import { registerCustomChatTaskPlanTool } from "./task-plan-tool.js";
```

In the `registerFull` method, add:

```typescript
registerCustomChatTaskPlanTool(api);
```

(Add it alongside the other `registerCustomChat*` calls.)

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add plugins/customchat/task-plan-tool.ts plugins/customchat/index.ts
git commit -m "feat(task-plan): add task_plan plugin tool"
```

---

## Task 7: RPC handler for `task_plan.update_field`

**Files:**
- Create: `lib/task-mode/plan-rpc-handlers.ts`
- Modify: `lib/customchat-app-rpc.ts`

- [ ] **Step 1: Create plan-rpc-handlers.ts**

```typescript
/**
 * @module task-mode/plan-rpc-handlers
 * task_plan.* RPC handler。
 * Leader 在规划阶段调用 task_plan(update_field) 更新 TaskModePlan 字段。
 */
import "server-only";

import { updateTaskModePlanField } from "@/lib/task-mode/plan-store";
import { TASK_PLAN_FIELDS, type TaskModePlanField } from "@/lib/task-mode/types";
import { createLogger } from "@/lib/logger";

const log = createLogger("task-mode:plan-rpc");

type AppRpcParams = Record<string, unknown>;

function readStr(params: AppRpcParams, key: string): string {
  return typeof params[key] === "string" ? (params[key] as string).trim() : "";
}

export async function handleTaskPlanUpdateField(params: AppRpcParams) {
  const panelId = readStr(params, "panelId");
  if (!panelId) throw new Error("task_plan.update_field: panelId is required.");

  const field = readStr(params, "field") as TaskModePlanField;
  if (!TASK_PLAN_FIELDS.includes(field)) {
    throw new Error(`task_plan.update_field: invalid field "${field}". Must be one of: ${TASK_PLAN_FIELDS.join(", ")}`);
  }

  const raw = params.value;
  let value: string | string[];

  if (field === "goal") {
    value = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("\n") : "";
  } else {
    value = Array.isArray(raw)
      ? raw.filter((v): v is string => typeof v === "string")
      : typeof raw === "string"
      ? raw.split("\n").map((s) => s.trim()).filter(Boolean)
      : [];
  }

  const updated = await updateTaskModePlanField(panelId, field, value);

  log.input("handleTaskPlanUpdateField", { panelId, field });

  return { ok: true, plan: updated };
}
```

- [ ] **Step 2: Register in customchat-app-rpc.ts**

In `lib/customchat-app-rpc.ts`, add import near the top:

```typescript
import { handleTaskPlanUpdateField } from "@/lib/task-mode/plan-rpc-handlers";
```

In the main switch/dispatch block where `case "group_task":` is handled, add before it:

```typescript
case "task_plan.update_field":
  return handleTaskPlanUpdateField(params);
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add lib/task-mode/plan-rpc-handlers.ts lib/customchat-app-rpc.ts
git commit -m "feat(task-plan): add task_plan.update_field RPC handler"
```

---

## Task 8: Confirm-plan API

**Files:**
- Create: `app/api/panels/[panelId]/task-plan/confirm/route.ts`

This endpoint does three things atomically:
1. Marks `plan.status = "confirmed"`
2. Sends Leader a message: confirmed plan contents + execution-phase prompt
3. Resets `isTaskModeFirstDispatch` so execution-phase prompt injection works correctly

- [ ] **Step 1: Create file**

```typescript
/**
 * @file POST /api/panels/[panelId]/task-plan/confirm
 * 用户确认规划方案，切换到执行阶段：
 * 1. plan.status → confirmed
 * 2. 向 Leader 发送系统消息，注入执行阶段提示词 + 完整 Plan 内容
 * 3. 重置 leader 的 firstDispatch 标记（使执行阶段提示词能重新注入）
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser, listGroupRoles } from "@/lib/store";
import { confirmTaskModePlan, getOrCreateTaskModePlan } from "@/lib/task-mode/plan-store";
import { resetTaskModeInitialized } from "@/lib/task-mode/dispatch";
import {
  ensureCustomChatBridgeServer,
  sendInboundToPlugin,
} from "@/lib/customchat-bridge-server";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type RouteContext = { params: Promise<{ panelId: string }> };

function loadPrompt(filename: string): string {
  try {
    return fs.readFileSync(path.join(process.cwd(), "prompt", filename), "utf-8");
  } catch {
    return "";
  }
}

function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

function formatList(items: string[]): string {
  return items.length === 0 ? "（未填写）" : items.map((s) => `- ${s}`).join("\n");
}

function formatMembersList(
  roles: Array<{ id: string; title: string; isLeader?: boolean; enabled: boolean }>,
  excludeId: string,
): string {
  const others = roles.filter((r) => r.enabled && r.id !== excludeId);
  if (others.length === 0) return "（暂无其他成员）";
  return others.map((r) => (r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`)).join("\n");
}

export async function POST(_req: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) return NextResponse.json({ error: "Panel not found." }, { status: 404 });

  // 1. 确认 Plan
  const plan = await confirmTaskModePlan(panelId);

  // 2. 构造执行阶段注入消息
  const roles = await listGroupRoles(panelId);
  const leader = roles.find((r) => r.isLeader && r.enabled);
  if (!leader) return NextResponse.json({ ok: true, plan }); // 无 leader，仅确认状态

  const leaderPrompt = loadPrompt("group-task-leader.md");
  const membersList = formatMembersList(roles, leader.id);
  const executionPrompt = leaderPrompt
    ? applyVars(leaderPrompt, {
        ROLE_NAME: leader.title,
        GROUP_NAME: panel.title,
        MEMBERS_LIST: membersList,
        PANEL_ID: panelId,
      })
    : "";

  const planSummary = [
    `【已确认计划】`,
    `目标：${plan.goal || "（未填写）"}`,
    ``,
    `约束条件：\n${formatList(plan.constraints)}`,
    ``,
    `交付物：\n${formatList(plan.deliverables)}`,
    ``,
    `验收标准：\n${formatList(plan.acceptanceCriteria)}`,
    ``,
    `任务草稿：\n${formatList(plan.taskOutline)}`,
  ].join("\n");

  const textToSend = [
    executionPrompt,
    "",
    planSummary,
    "",
    "[系统] 用户已确认以上规划方案，现在进入执行阶段。",
    "请根据计划立即开始调用 group_task(create_task) 创建细化任务并分配给各成员。",
  ]
    .filter(Boolean)
    .join("\n");

  // 3. 重置 firstDispatch 标记，让上面注入的执行提示词生效
  resetTaskModeInitialized(panelId, leader.id);

  // 4. 发送到 Leader
  await ensureCustomChatBridgeServer();
  const target = toCustomChatGroupRoleTarget(panelId, leader.id);
  await sendInboundToPlugin({
    panelId,
    agentId: leader.agentId,
    target,
    messageId: crypto.randomUUID(),
    text: textToSend,
    attachments: [],
  }).catch(() => null);

  return NextResponse.json({ ok: true, plan });
}
```

- [ ] **Step 2: Add `resetTaskModeInitialized` to dispatch.ts**

In `lib/task-mode/dispatch.ts`, find `markTaskModeInitialized` and add right after it:

```typescript
/** 重置指定角色的首次 dispatch 标记，使下次 dispatch 重新注入提示词。 */
export function resetTaskModeInitialized(panelId: string, roleId: string): void {
  const key = `${panelId}:${roleId}`;
  initializedSessions.delete(key);
}
```

(Check what the Set/Map is called in dispatch.ts — it may be `initializedSessions` or similar. Match the naming.)

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add "app/api/panels/[panelId]/task-plan/confirm/route.ts" lib/task-mode/dispatch.ts
git commit -m "feat(task-plan): add confirm-plan API + resetTaskModeInitialized"
```

---

## Task 9: Execution gate in `handleCreateTask`

**Files:**
- Modify: `lib/task-mode/app-rpc-handlers.ts`

- [ ] **Step 1: Add plan status check at the start of `handleCreateTask`**

In `lib/task-mode/app-rpc-handlers.ts`, add import at top:

```typescript
import { getTaskModePlan } from "@/lib/task-mode/plan-store";
```

Inside `handleCreateTask`, right after `const caller = await resolveCallerRole(panelId, params);`, add:

```typescript
// 执行门控：Plan 未确认前禁止创建任务
const plan = await getTaskModePlan(panelId);
if (!plan || plan.status !== "confirmed") {
  throw new Error(
    "规划方案尚未确认。请先完成规划阶段（与用户对齐目标、约束、验收标准），" +
    "填写完所有 task_plan 字段后，提示用户点击「确认计划」按钮，再创建任务。",
  );
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add lib/task-mode/app-rpc-handlers.ts
git commit -m "feat(task-plan): gate create_task behind plan confirmed"
```

---

## Task 10: Inject planning prompt in message routing

**Files:**
- Modify: `lib/task-mode/group-task-message.ts`

Currently this file always injects `group-task-leader.md` on first dispatch. We need to inject `group-task-plan.md` instead when the plan is not yet confirmed.

- [ ] **Step 1: Modify `submitGroupTaskMessage`**

Add import at top of the file:

```typescript
import { getTaskModePlan } from "@/lib/task-mode/plan-store";
```

Find the block:

```typescript
if (isTaskModeFirstDispatch(input.panel.id, leader.id)) {
  const template = loadPromptFile("group-task-leader.md");
```

Replace the entire `if (isTaskModeFirstDispatch(...))` block with:

```typescript
if (isTaskModeFirstDispatch(input.panel.id, leader.id)) {
  // 规划阶段未完成时注入规划提示词，否则注入执行提示词
  const plan = await getTaskModePlan(input.panel.id);
  const isPlanConfirmed = plan?.status === "confirmed";
  const promptFile = isPlanConfirmed ? "group-task-leader.md" : "group-task-plan.md";

  const template = loadPromptFile(promptFile);
  if (template) {
    const membersList = formatMembersList(groupRoles, leader.id);
    const prompt = applyTemplateVars(template, {
      ROLE_NAME: leader.title,
      GROUP_NAME: input.panel.title,
      MEMBERS_LIST: membersList,
      PANEL_ID: input.panel.id,
    });
    textToSend = `${prompt}\n\n[来自用户]:\n${messageText}`;
  } else {
    textToSend = `[来自用户]:\n${messageText}`;
  }
  markTaskModeInitialized(input.panel.id, leader.id);
} else {
  textToSend = `[来自用户]:\n${messageText}`;
}
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add lib/task-mode/group-task-message.ts
git commit -m "feat(task-plan): inject planning prompt when plan not confirmed"
```

---

## Task 11: Write planning-phase prompt

**Files:**
- Create: `prompt/group-task-plan.md`

This is the most critical piece. The prompt must make Leader:
1. First read group context (members, memory) before asking
2. Ask one targeted question per turn
3. Call `task_plan(update_field)` after each answer
4. NOT call `group_task` or `create_task`
5. Know when all fields are filled and tell user to confirm

- [ ] **Step 1: Create the prompt**

```markdown
[任务模式 — 规划阶段]
你正在群组「{{GROUP_NAME}}」中担任组长，角色名「{{ROLE_NAME}}」。
现在处于【规划阶段】。你的职责是通过多轮对话，与用户共同产出一份完整的任务计划，再进入执行阶段。

[当前群上下文]
- panelId：{{PANEL_ID}}
- 群内成员：
{{MEMBERS_LIST}}

[规划阶段工作流程]
1. 读取上下文（只做一次）
   - 调用 manage_group_memory(action="get") 读取群记忆，了解已有背景信息
   - 基于成员列表了解可用的执行角色
   - 无需向用户汇报这个步骤，直接进入提问

2. 逐字段收集信息（每次只问一个问题）
   按以下顺序依次确认每个字段，每个字段得到明确答案后立即调用 task_plan(update_field) 写入：
   
   a. goal（目标）：用一句话描述最终交付的是什么、它要实现什么效果
   b. constraints（约束）：技术栈要求、风格规范、不能改动的边界、时间限制等
   c. deliverables（交付物）：产出物的具体形式，如"可运行的 Next.js 项目"、"部署在 xxx 的 API"
   d. acceptanceCriteria（验收标准）：用户怎么判断任务完成，要能用"是/否"验证
   e. taskOutline（任务草稿）：你基于以上信息给出的高层拆分（3～6 个条目），向用户确认方向

3. 全部填写完毕后：
   - 向用户做一个简洁的计划摘要（3～5 行）
   - 明确告知：「计划已就绪，请点击下方「确认计划」按钮进入执行阶段」
   - 等待用户确认，不要自行进入执行阶段

[task_plan 工具说明]
- action: "update_field"：更新计划字段
- field：要更新的字段名（goal / constraints / deliverables / acceptanceCriteria / taskOutline）
- value：字段值（goal 为 string，其余为 string[]）
- 每得到一个字段的答案，立即调用一次 task_plan，不要等到全部收集完再批量写入

[严格禁止]
- ❌ 不得在规划阶段调用 group_task（系统会拒绝 create_task）
- ❌ 不得跳过字段、自行假设用户意图填入内容（必须从用户处获得明确答案）
- ❌ 不得一次提问多个字段（每轮只问一个）
- ❌ 不得在用户确认前自行宣布"进入执行阶段"

[提问原则]
- 问题要具体，不要用"请描述你的需求"这种开放式问法
- 每个问题后面可以给 2～3 个参考选项，帮助用户快速回答
- 如果用户的回答不够清晰，追问一次再写入字段
- constraints / deliverables / acceptanceCriteria 如果用户说"没有特别要求"，写入空数组 [] 也可以

[回复原则]
- 规划阶段的对话要简洁，不要长篇介绍自己的流程
- 直接进入第一个问题，不要先做自我介绍
- 调用 task_plan 后无需向用户报告"已更新字段 xxx"，直接进入下一个问题
```

- [ ] **Step 2: Verify file is UTF-8 and readable**

```bash
head -5 prompt/group-task-plan.md
```

Expected: shows the first few lines of the file.

- [ ] **Step 3: Commit**

```bash
git add prompt/group-task-plan.md
git commit -m "feat(task-plan): add planning-phase leader prompt"
```

---

## Task 12: Frontend — `task-mode-plan-view.tsx`

**Files:**
- Create: `components/task-mode/task-mode-plan-view.tsx`

This component is shown in the right column of the task mode panel during the planning phase, replacing the task board.

- [ ] **Step 1: Create component**

```typescript
"use client";

import type { TaskModePlan } from "@/lib/task-mode/types";

interface Props {
  plan: TaskModePlan;
  isConfirming: boolean;
  onConfirm: () => void;
}

function PlanSection({
  label,
  value,
}: {
  label: string;
  value: string | string[];
}) {
  const isEmpty =
    typeof value === "string" ? !value.trim() : value.length === 0;

  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold text-[var(--ink-soft)] uppercase tracking-wide">
        {label}
      </div>
      {isEmpty ? (
        <div className="text-xs text-[var(--ink-soft)] italic">待填写…</div>
      ) : typeof value === "string" ? (
        <div className="text-sm text-[var(--ink)] leading-relaxed">{value}</div>
      ) : (
        <ul className="space-y-0.5">
          {value.map((item, i) => (
            <li key={i} className="text-sm text-[var(--ink)] leading-relaxed flex gap-2">
              <span className="text-[var(--ink-soft)] shrink-0">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function filledFieldCount(plan: TaskModePlan): number {
  let count = 0;
  if (plan.goal.trim()) count++;
  if (plan.constraints.length > 0) count++;
  if (plan.deliverables.length > 0) count++;
  if (plan.acceptanceCriteria.length > 0) count++;
  if (plan.taskOutline.length > 0) count++;
  return count;
}

export function TaskModePlanView({ plan, isConfirming, onConfirm }: Props) {
  const filled = filledFieldCount(plan);
  const total = 5;
  const allFilled = filled === total;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-black/8 px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-[var(--ink)]">规划方案</span>
          <span className="text-xs text-[var(--ink-soft)]">
            {filled} / {total} 已填写
          </span>
        </div>
        {/* Progress bar */}
        <div className="mt-1.5 h-1 rounded-full bg-black/8 overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
            style={{ width: `${(filled / total) * 100}%` }}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        <PlanSection label="目标" value={plan.goal} />
        <PlanSection label="约束条件" value={plan.constraints} />
        <PlanSection label="交付物" value={plan.deliverables} />
        <PlanSection label="验收标准" value={plan.acceptanceCriteria} />
        <PlanSection label="任务草稿" value={plan.taskOutline} />
      </div>

      {/* Confirm button */}
      <div className="shrink-0 border-t border-black/8 p-3">
        {!allFilled && (
          <p className="mb-2 text-[11px] text-[var(--ink-soft)] text-center">
            与 Leader 完成规划对话后即可确认
          </p>
        )}
        <button
          type="button"
          onClick={onConfirm}
          disabled={isConfirming}
          className="w-full rounded-xl bg-[var(--ink)] py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isConfirming ? "确认中…" : "确认计划，进入执行阶段"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add components/task-mode/task-mode-plan-view.tsx
git commit -m "feat(task-plan): add TaskModePlanView component"
```

---

## Task 13: Wire up plan view in `task-mode-panel-card.tsx`

**Files:**
- Modify: `components/task-mode/task-mode-panel-card.tsx`

This is the integration task. The panel card needs to:
1. Fetch initial plan on mount
2. Subscribe to `plan_updated` SSE event and re-fetch
3. Show `TaskModePlanView` (right column) instead of task board when plan is drafting
4. Handle "confirm plan" button click

- [ ] **Step 1: Add plan state and fetching**

At the top of the component (near the other `useState` calls), add:

```typescript
import type { TaskModePlan } from "@/lib/task-mode/types";
import { TaskModePlanView } from "@/components/task-mode/task-mode-plan-view";

// Inside the component:
const [plan, setPlan] = useState<TaskModePlan | null>(null);
const [isConfirmingPlan, setIsConfirmingPlan] = useState(false);
```

Add a fetch function:

```typescript
const fetchPlan = useCallback(async () => {
  const resp = await fetch(`/api/panels/${panel.id}/task-plan`).catch(() => null);
  if (!resp?.ok) return;
  const data = await resp.json().catch(() => null);
  if (data?.plan) setPlan(data.plan as TaskModePlan);
}, [panel.id]);
```

In the initial load `useEffect` (wherever `fetchTasks` is called on mount), also call `fetchPlan()`.

- [ ] **Step 2: Subscribe to `plan_updated` SSE event**

In the SSE event handler (where `source.addEventListener("chat", ...)` and `source.addEventListener("tasks_updated", ...)` are handled), add:

```typescript
source.addEventListener("plan_updated", () => {
  void fetchPlan();
});
```

- [ ] **Step 3: Add confirm handler**

```typescript
const handleConfirmPlan = useCallback(async () => {
  setIsConfirmingPlan(true);
  try {
    const resp = await fetch(`/api/panels/${panel.id}/task-plan/confirm`, {
      method: "POST",
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data?.plan) setPlan(data.plan as TaskModePlan);
    }
  } finally {
    setIsConfirmingPlan(false);
  }
}, [panel.id]);
```

- [ ] **Step 4: Conditional right-column rendering**

Find where `<TaskModeBoard ... />` is rendered in the right column. Wrap it with a conditional:

```tsx
{/* Right column: plan view during planning, task board during execution */}
{plan && plan.status !== "confirmed" ? (
  <TaskModePlanView
    plan={plan}
    isConfirming={isConfirmingPlan}
    onConfirm={handleConfirmPlan}
  />
) : (
  <TaskModeBoard ... />
)}
```

- [ ] **Step 5: Verify compile**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Full build**

```bash
npm run build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add components/task-mode/task-mode-panel-card.tsx
git commit -m "feat(task-plan): wire plan view into panel card"
```

---

## Task 14: Rebuild and smoke test

- [ ] **Step 1: Rebuild and restart**

```bash
bash /Users/siyushi/openclaw-cmds/chatbot-rebuild-and-restart.sh
```

- [ ] **Step 2: Manual smoke test — planning phase**

1. Create a new task mode group panel
2. Send a message to Leader
3. Verify: right column shows **Plan 预览面板** (not task board), with all 5 fields empty
4. Verify: Leader responds with a targeted question (not immediately creating tasks)
5. Answer the question
6. Verify: the corresponding Plan field updates in real-time in the right panel
7. Continue until all 5 fields have content
8. Click "确认计划，进入执行阶段"
9. Verify: right column switches to task board
10. Verify: Leader starts creating tasks based on the plan

- [ ] **Step 3: Smoke test — gate enforcement**

In a panel with an unconfirmed plan, use the Gateway UI or logs to confirm that any `create_task` call from Leader returns the error message about plan not confirmed.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(task-plan): complete Plan Phase implementation"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Covered by |
|---|---|
| Leader uses `task_plan(update_field)` tool | Task 6, 7 |
| Plan fields: goal / constraints / deliverables / acceptanceCriteria / taskOutline | Task 1, 6 |
| `create_task` gated until plan confirmed | Task 9 |
| Real-time Plan preview panel | Task 12, 13 |
| `plan_updated` SSE event | Task 4 |
| `POST /task-plan/confirm` sends execution prompt to Leader | Task 8 |
| Planning-phase leader prompt | Task 11 |
| `resetTaskModeInitialized` so execution prompt re-injects | Task 8 |
| Planning prompt injected on first dispatch when plan unconfirmed | Task 10 |
| AppData persistence | Task 2 |

**Gaps to watch:**
- `nowIso` existence in `lib/utils.ts` — checked in Task 3 Step 2
- The `initializedSessions` variable name in `dispatch.ts` — check actual name in Task 8 Step 2
- The exact location of the right-column `<TaskModeBoard />` in `task-mode-panel-card.tsx` — the engineer should inspect the file structure before editing Task 13 Step 4
