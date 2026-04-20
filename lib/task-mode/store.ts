/**
 * @module task-mode/store
 * 任务模式的持久化操作层。
 * 所有任务 CRUD、事件追加、pending dispatch 队列管理均在此模块。
 * 不依赖聊天模式的任何业务函数，仅复用基础设施（mutateData、nowIso 等）。
 */
import "server-only";

import crypto from "node:crypto";

import { createLogger } from "@/lib/logger";
import { nowIso } from "@/lib/utils";
import type {
  GroupTaskEvent,
  GroupTaskEventType,
  GroupTaskStatus,
  GroupTaskTextOutput,
  StoredGroupTask,
} from "@/lib/task-mode/types";
import { TASK_TERMINAL_STATUSES } from "@/lib/task-mode/types";

// 需要直接读写 AppData，借用 store 内部的 mutateData / readData
// 但这些是 store 内部函数，不对外暴露——通过条件 import 间接使用
// 实际工程上最简单的做法：用 Next.js 的 "server-only" + 直接 import store 的公开函数
// 对于 raw AppData 操作，我们通过新增导出的 mutateAppData/readAppData 来实现
import { mutateGroupTasks, readGroupTasks } from "@/lib/store";
import { publishGroupTasksUpdate } from "@/lib/task-mode/sse";

const log = createLogger("task-mode:store");

// ─────────────────────────────────────────────────────────────
// In-memory pending dispatch 队列
// key = assigneeRoleId, value = 等待 dispatch 的 taskId 列表（FIFO）
// ─────────────────────────────────────────────────────────────

const pendingDispatchQueues = new Map<string, string[]>();

/** 重建所有面板的 pending dispatch 队列（进程启动时调用） */
export function rebuildPendingDispatchQueues(tasks: StoredGroupTask[]) {
  pendingDispatchQueues.clear();

  // 按 assigneeRoleId 分组
  const byAssignee = new Map<string, StoredGroupTask[]>();
  for (const task of tasks) {
    if (!task.assigneeRoleId) continue;
    const list = byAssignee.get(task.assigneeRoleId) ?? [];
    list.push(task);
    byAssignee.set(task.assigneeRoleId, list);
  }

  for (const [assigneeRoleId, assigneeTasks] of byAssignee) {
    // 当前占用执行位的任务（in_progress 或 blocked）
    const activeTask = assigneeTasks.find(
      (t) => t.status === "in_progress" || t.status === "blocked",
    );

    // 等待 dispatch 的任务：assigned 且不是当前活跃任务
    const waiting = assigneeTasks
      .filter((t) => t.status === "assigned" && t.id !== activeTask?.id)
      .sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

    if (waiting.length > 0) {
      pendingDispatchQueues.set(
        assigneeRoleId,
        waiting.map((t) => t.id),
      );
    }
  }

  log.debug("rebuildPendingDispatchQueues", {
    queueCount: String(pendingDispatchQueues.size),
  });
}

/** 向 assignee 的 pending dispatch 队列末尾追加任务 */
export function enqueuePendingDispatch(assigneeRoleId: string, taskId: string) {
  const queue = pendingDispatchQueues.get(assigneeRoleId) ?? [];
  if (!queue.includes(taskId)) {
    queue.push(taskId);
    pendingDispatchQueues.set(assigneeRoleId, queue);
  }
}

/** 取出队首任务（并从队列移除），若队列为空返回 null */
export function dequeuePendingDispatch(assigneeRoleId: string): string | null {
  const queue = pendingDispatchQueues.get(assigneeRoleId);
  if (!queue || queue.length === 0) return null;
  const taskId = queue.shift()!;
  if (queue.length === 0) pendingDispatchQueues.delete(assigneeRoleId);
  return taskId;
}

/** 将被 reject 的任务放回队首（优先于其他等待任务） */
export function requeueRejectedTask(assigneeRoleId: string, taskId: string) {
  const queue = pendingDispatchQueues.get(assigneeRoleId) ?? [];
  // 如果已经在队列里就移除，再插回队首
  const filtered = queue.filter((id) => id !== taskId);
  filtered.unshift(taskId);
  pendingDispatchQueues.set(assigneeRoleId, filtered);
}

/** 检查某 assignee 是否当前有 in_progress/blocked 任务（占用执行位） */
export async function hasActiveTask(
  panelId: string,
  assigneeRoleId: string,
): Promise<boolean> {
  const tasks = await readGroupTasks(panelId);
  return tasks.some(
    (t) =>
      t.assigneeRoleId === assigneeRoleId &&
      (t.status === "in_progress" || t.status === "blocked"),
  );
}

// ─────────────────────────────────────────────────────────────
// Task CRUD
// ─────────────────────────────────────────────────────────────

export async function createGroupTask(input: {
  panelId: string;
  title: string;
  description: string;
  status: GroupTaskStatus;
  creatorRoleId: string;
  creatorRoleTitle: string;
  assigneeRoleId?: string;
  assigneeRoleTitle?: string;
  parentTaskId?: string;
  dependsOnTaskIds?: string[];
  autoApprove?: boolean;
}): Promise<StoredGroupTask> {
  const now = nowIso();
  const task: StoredGroupTask = {
    id: crypto.randomUUID(),
    panelId: input.panelId,
    title: input.title,
    description: input.description,
    status: input.status,
    creatorRoleId: input.creatorRoleId,
    creatorRoleTitle: input.creatorRoleTitle,
    assigneeRoleId: input.assigneeRoleId,
    assigneeRoleTitle: input.assigneeRoleTitle,
    parentTaskId: input.parentTaskId,
    dependsOnTaskIds: input.dependsOnTaskIds ?? [],
    autoApprove: input.autoApprove ?? false,
    textOutputs: [],
    activeRunId: null,
    watchdogRetryCount: 0,
    events: [
      {
        id: crypto.randomUUID(),
        type: "created",
        actorRoleId: input.creatorRoleId,
        actorRoleTitle: input.creatorRoleTitle,
        ts: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  await mutateGroupTasks(input.panelId, (tasks) => {
    tasks.push(task);
  });

  publishGroupTasksUpdate(input.panelId);
  return task;
}

export async function getGroupTask(
  panelId: string,
  taskId: string,
): Promise<StoredGroupTask | null> {
  const tasks = await readGroupTasks(panelId);
  return tasks.find((t) => t.id === taskId) ?? null;
}

export async function updateGroupTaskStatus(
  panelId: string,
  taskId: string,
  status: GroupTaskStatus,
  event: {
    type: GroupTaskEventType;
    actorRoleId: string;
    actorRoleTitle: string;
    note?: string;
  },
): Promise<StoredGroupTask> {
  const result = await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const prevStatus = task.status;
    task.status = status;
    task.updatedAt = nowIso();

    // 终态时清空 activeRunId
    if (TASK_TERMINAL_STATUSES.has(status)) {
      task.activeRunId = null;
    }

    task.events.push({
      id: crypto.randomUUID(),
      type: event.type,
      actorRoleId: event.actorRoleId,
      actorRoleTitle: event.actorRoleTitle,
      note: event.note,
      ts: task.updatedAt,
    });

    log.debug("updateGroupTaskStatus", {
      taskId,
      from: prevStatus,
      to: status,
    });

    return task;
  });
  publishGroupTasksUpdate(panelId);
  return result;
}

export async function updateGroupTaskField<
  K extends keyof StoredGroupTask,
>(
  panelId: string,
  taskId: string,
  field: K,
  value: StoredGroupTask[K],
): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task[field] = value;
    task.updatedAt = nowIso();
  });
  publishGroupTasksUpdate(panelId);
}

export async function appendTaskEvent(
  panelId: string,
  taskId: string,
  event: Omit<GroupTaskEvent, "id" | "ts">,
): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.events.push({
      id: crypto.randomUUID(),
      ts: nowIso(),
      ...event,
    });
    task.updatedAt = nowIso();
  });
  publishGroupTasksUpdate(panelId);
}

export async function appendTaskTextOutput(
  panelId: string,
  taskId: string,
  output: Omit<GroupTaskTextOutput, "id">,
): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    task.textOutputs.push({ id: crypto.randomUUID(), ...output });
    task.updatedAt = nowIso();
  });
  publishGroupTasksUpdate(panelId);
}

export async function addTaskDependency(
  panelId: string,
  taskId: string,
  dependsOnTaskId: string,
): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.dependsOnTaskIds.includes(dependsOnTaskId)) {
      task.dependsOnTaskIds.push(dependsOnTaskId);
      task.updatedAt = nowIso();
    }
  });
  publishGroupTasksUpdate(panelId);
}

/**
 * 设置任务的 lastDispatchAt 和 activeRunId（在 dispatch 后调用）。
 */
export async function recordTaskDispatch(
  panelId: string,
  taskId: string,
  activeRunId: string | null = null,
): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.lastDispatchAt = nowIso();
    task.activeRunId = activeRunId;
    task.updatedAt = nowIso();
  });
  publishGroupTasksUpdate(panelId);
}

/**
 * 重启后清空所有任务的 activeRunId（对应 run 已不在内存中）。
 */
export async function clearAllActiveRunIds(panelId: string): Promise<void> {
  await mutateGroupTasks(panelId, (tasks) => {
    for (const task of tasks) {
      if (task.panelId === panelId) {
        task.activeRunId = null;
      }
    }
  });
}
