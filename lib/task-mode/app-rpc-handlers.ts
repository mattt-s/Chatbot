/**
 * @module task-mode/app-rpc-handlers
 * group_task.* 的所有 RPC handler。
 * 状态机转换、依赖触发、串行化队列、循环检测、验收者校验均在此处理。
 * 完全独立于聊天模式的 RPC handlers。
 */
import "server-only";

import {
  createGroupTask,
  getGroupTask,
  updateGroupTaskStatus,
  updateGroupTaskField,
  addTaskDependency,
  appendTaskEvent,
  hasActiveTask,
  enqueuePendingDispatch,
  dequeuePendingDispatch,
  requeueRejectedTask,
} from "@/lib/task-mode/store";
import {
  dispatchTaskMessage,
  buildAssignmentMessage,
  buildRejectionMessage,
  buildReviewRequestMessage,
  buildBlockedNotificationMessage,
  buildWatchdogRetryMessage,
  buildWatchdogAbortRetryMessage,
  buildWatchdogSubmitReminderMessage,
} from "@/lib/task-mode/dispatch";
import { detectCycle } from "@/lib/task-mode/cycle-detect";
import { taskToView } from "@/lib/task-mode/types";
import { TASK_TERMINAL_STATUSES } from "@/lib/task-mode/types";
import { readGroupTasks } from "@/lib/store";
import { listGroupRoles } from "@/lib/store";
import { abortGroupRoleRun, getRoleCurrentRunId } from "@/lib/group-router";
import { createLogger } from "@/lib/logger";

const log = createLogger("task-mode:rpc");

type RpcParams = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────

function readStr(params: RpcParams, key: string, required = false): string {
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) throw new Error(`${key} is required.`);
    return "";
  }
  const val = raw.trim();
  if (!val && required) throw new Error(`${key} is required.`);
  return val;
}

function readBool(params: RpcParams, key: string, defaultValue = false): boolean {
  return typeof params[key] === "boolean" ? (params[key] as boolean) : defaultValue;
}

/** 通过 panelId 和 roleTitle 找到角色信息。 */
async function resolveRoleByTitle(panelId: string, roleTitle: string) {
  const roles = await listGroupRoles(panelId);
  if (roles.length === 0) {
    throw new Error(
      `群组 panelId "${panelId}" 未找到任何角色。请确认传入的是真实 panelId（不要填群名）。`,
    );
  }
  const role = roles.find((r) => r.title === roleTitle && r.enabled);
  if (!role) throw new Error(`角色 "${roleTitle}" 不存在或已禁用。`);
  return role;
}

/** 找到调用方角色。 */
async function resolveCallerRole(panelId: string, params: RpcParams) {
  const callerRoleId = readStr(params, "callerRoleId");
  const callerRoleTitle = readStr(params, "callerRoleTitle");
  const roles = await listGroupRoles(panelId);
  if (roles.length === 0) {
    throw new Error(
      `群组 panelId "${panelId}" 未找到任何角色。请确认传入的是真实 panelId（不要填群名）。`,
    );
  }

  if (callerRoleId) {
    const role = roles.find((r) => r.id === callerRoleId);
    if (!role) throw new Error(`调用方角色 ID "${callerRoleId}" 不存在。`);
    return role;
  }
  if (callerRoleTitle) {
    const role = roles.find((r) => r.title === callerRoleTitle);
    if (!role) throw new Error(`调用方角色 "${callerRoleTitle}" 不存在。`);
    return role;
  }
  throw new Error("缺少调用方标识：callerRoleId 或 callerRoleTitle。");
}

/** 检查前置任务是否全部完成。 */
async function checkAllDependenciesDone(
  panelId: string,
  dependsOnTaskIds: string[],
): Promise<{ allDone: boolean; firstPendingId: string | null }> {
  if (dependsOnTaskIds.length === 0) return { allDone: true, firstPendingId: null };
  const tasks = await readGroupTasks(panelId);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  for (const depId of dependsOnTaskIds) {
    const dep = taskMap.get(depId);
    if (!dep || dep.status !== "done") {
      return { allDone: false, firstPendingId: depId };
    }
  }
  return { allDone: true, firstPendingId: null };
}

/** 任务 T 完成后，触发所有依赖 T 的任务。 */
async function triggerDependentTasks(panelId: string, doneTaskId: string) {
  const tasks = await readGroupTasks(panelId);
  const candidates = tasks.filter(
    (t) =>
      (t.status === "created" || t.status === "blocked") &&
      t.dependsOnTaskIds.includes(doneTaskId),
  );

  for (const candidate of candidates) {
    const { allDone } = await checkAllDependenciesDone(panelId, candidate.dependsOnTaskIds);
    if (!allDone) continue;

    const assigneeRoleId = candidate.assigneeRoleId;
    if (!assigneeRoleId || !candidate.assigneeRoleTitle) continue;

    await updateGroupTaskStatus(panelId, candidate.id, "assigned", {
      type: "assigned",
      actorRoleId: "app",
      actorRoleTitle: "系统",
      note: "前置任务全部完成，自动触发",
    });

    const busy = await hasActiveTask(panelId, assigneeRoleId);
    if (busy) {
      enqueuePendingDispatch(assigneeRoleId, candidate.id);
      log.debug("triggerDependentTasks.enqueued", { taskId: candidate.id, assigneeRoleId });
      continue;
    }

    const roles = await listGroupRoles(panelId);
    const role = roles.find((r) => r.id === assigneeRoleId);
    if (!role) continue;

    await dispatchTaskMessage({
      panelId,
      roleId: assigneeRoleId,
      agentId: role.agentId,
      text: buildAssignmentMessage(candidate),
      taskId: candidate.id,
      isLeader: role.isLeader === true,
      roleTitle: role.title,
    });
  }
}

/** 当前任务终态后，从队列取下一个任务 dispatch。 */
async function flushPendingDispatch(panelId: string, assigneeRoleId: string) {
  const nextTaskId = dequeuePendingDispatch(assigneeRoleId);
  if (!nextTaskId) return;

  const task = await getGroupTask(panelId, nextTaskId);
  if (!task || task.status !== "assigned") return;

  const roles = await listGroupRoles(panelId);
  const role = roles.find((r) => r.id === assigneeRoleId);
  if (!role) return;

  const text = task.reviewNote
    ? buildRejectionMessage(task)
    : buildAssignmentMessage(task);

  await dispatchTaskMessage({
    panelId,
    roleId: assigneeRoleId,
    agentId: role.agentId,
    text,
    taskId: nextTaskId,
    isLeader: role.isLeader === true,
    roleTitle: role.title,
  });
}

// ─────────────────────────────────────────────────────────────
// Handler: create_task
// ─────────────────────────────────────────────────────────────

async function handleCreateTask(panelId: string, params: RpcParams) {
  const caller = await resolveCallerRole(panelId, params);
  const title = readStr(params, "title", true);
  const description = readStr(params, "description", true);
  const assigneeTitle = readStr(params, "assigneeTitle", true);
  const reviewerTitle = readStr(params, "reviewerTitle"); // 可选，不填时默认 leader
  const parentTaskId = readStr(params, "parentTaskId") || undefined;
  const autoApprove = readBool(params, "autoApprove", false);
  const dependsOnTaskIds = Array.isArray(params.dependsOnTaskIds)
    ? (params.dependsOnTaskIds as unknown[])
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
    : [];

  const assigneeRole = await resolveRoleByTitle(panelId, assigneeTitle);

  // 解析验收者（autoApprove=true 时不需要）
  let reviewerRoleId: string | undefined;
  let reviewerRoleTitle: string | undefined;

  if (!autoApprove) {
    let reviewerRole;
    if (reviewerTitle) {
      reviewerRole = await resolveRoleByTitle(panelId, reviewerTitle);
    } else {
      // 默认使用 leader 作为验收者
      const roles = await listGroupRoles(panelId);
      reviewerRole = roles.find((r) => r.isLeader && r.enabled);
      if (!reviewerRole) {
        throw new Error(
          "未指定 reviewerTitle 且群组没有 leader，请通过 reviewerTitle 明确指定验收者。",
        );
      }
    }
    // 执行者与验收者不能相同
    if (reviewerRole.id === assigneeRole.id) {
      throw new Error(
        `执行者和验收者不能是同一角色（"${assigneeRole.title}"）。请通过 reviewerTitle 指定其他角色。`,
      );
    }
    reviewerRoleId = reviewerRole.id;
    reviewerRoleTitle = reviewerRole.title;
  }

  // 校验前置任务存在
  if (dependsOnTaskIds.length > 0) {
    const tasks = await readGroupTasks(panelId);
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    for (const depId of dependsOnTaskIds) {
      if (!taskMap.has(depId)) throw new Error(`前置任务 ID "${depId}" 不存在。`);
    }
  }

  // 确定初始状态（无 pending_approval，所有任务直接进入正常流程）
  let status: import("@/lib/task-mode/types").GroupTaskStatus;
  if (dependsOnTaskIds.length > 0) {
    const { allDone } = await checkAllDependenciesDone(panelId, dependsOnTaskIds);
    status = allDone ? "assigned" : "created";
  } else {
    status = "assigned";
  }

  const task = await createGroupTask({
    panelId,
    title,
    description,
    status,
    creatorRoleId: caller.id,
    creatorRoleTitle: caller.title,
    assigneeRoleId: assigneeRole.id,
    assigneeRoleTitle: assigneeRole.title,
    reviewerRoleId,
    reviewerRoleTitle,
    parentTaskId,
    dependsOnTaskIds,
    autoApprove,
  });

  if (status === "assigned") {
    const busy = await hasActiveTask(panelId, assigneeRole.id);
    if (busy) {
      enqueuePendingDispatch(assigneeRole.id, task.id);
    } else {
      await dispatchTaskMessage({
        panelId,
        roleId: assigneeRole.id,
        agentId: assigneeRole.agentId,
        text: buildAssignmentMessage(task),
        taskId: task.id,
        isLeader: assigneeRole.isLeader === true,
        roleTitle: assigneeRole.title,
      });
    }
  }
  // status=created 时仅等待前置任务，不 dispatch

  return { ok: true, task: taskToView(task) };
}

// ─────────────────────────────────────────────────────────────
// Handler: start_task
// ─────────────────────────────────────────────────────────────

async function handleStartTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const caller = await resolveCallerRole(panelId, params);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (task.assigneeRoleId !== caller.id) {
    throw new Error("只有 assignee 才能认领任务。");
  }
  if (task.status !== "assigned" && task.status !== "rejected") {
    throw new Error(`任务当前状态 "${task.status}" 不允许 start_task。`);
  }

  const updated = await updateGroupTaskStatus(panelId, taskId, "in_progress", {
    type: "started",
    actorRoleId: caller.id,
    actorRoleTitle: caller.title,
  });

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Handler: submit_task
// ─────────────────────────────────────────────────────────────

async function handleSubmitTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const note = readStr(params, "note");
  const caller = await resolveCallerRole(panelId, params);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (task.assigneeRoleId !== caller.id) {
    throw new Error("只有 assignee 才能提交任务。");
  }
  if (task.status !== "in_progress") {
    throw new Error(`任务当前状态 "${task.status}" 不允许 submit_task。`);
  }

  await updateGroupTaskField(panelId, taskId, "submissionNote", note || undefined);

  if (task.autoApprove) {
    const updated = await updateGroupTaskStatus(panelId, taskId, "done", {
      type: "approved",
      actorRoleId: "app",
      actorRoleTitle: "系统（autoApprove）",
      note: "autoApprove=true，提交即通过",
    });
    await triggerDependentTasks(panelId, taskId);
    if (task.assigneeRoleId) {
      await flushPendingDispatch(panelId, task.assigneeRoleId);
    }
    return { ok: true, task: taskToView(updated), autoApproved: true };
  }

  // 需要验收者审核
  if (!task.reviewerRoleId) {
    throw new Error("任务没有指定验收者（reviewerRoleId），无法提交审核。");
  }

  const updated = await updateGroupTaskStatus(panelId, taskId, "reviewing", {
    type: "submitted",
    actorRoleId: caller.id,
    actorRoleTitle: caller.title,
    note,
  });

  const roles = await listGroupRoles(panelId);
  const reviewer = roles.find((r) => r.id === task.reviewerRoleId);
  if (!reviewer) throw new Error(`验收者角色 "${task.reviewerRoleId}" 不存在。`);

  const taskWithNote = { ...task, submissionNote: note || undefined };
  await dispatchTaskMessage({
    panelId,
    roleId: reviewer.id,
    agentId: reviewer.agentId,
    text: buildReviewRequestMessage(taskWithNote),
    isLeader: reviewer.isLeader === true,
    roleTitle: reviewer.title,
  });

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Handler: approve_task
// ─────────────────────────────────────────────────────────────

async function handleApproveTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const caller = await resolveCallerRole(panelId, params);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (task.status !== "reviewing") {
    throw new Error(`任务当前状态 "${task.status}" 不允许 approve_task。`);
  }

  // 只有指定的验收者才能审批；执行者不能审批自己的任务
  if (caller.id === task.assigneeRoleId) {
    throw new Error("执行者不能验收自己的任务。");
  }
  if (task.reviewerRoleId && caller.id !== task.reviewerRoleId) {
    throw new Error(
      `只有指定的验收者（${task.reviewerRoleTitle ?? task.reviewerRoleId}）才能审批此任务。`,
    );
  }

  const updated = await updateGroupTaskStatus(panelId, taskId, "done", {
    type: "approved",
    actorRoleId: caller.id,
    actorRoleTitle: caller.title,
  });

  await triggerDependentTasks(panelId, taskId);
  if (task.assigneeRoleId) {
    await flushPendingDispatch(panelId, task.assigneeRoleId);
  }

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Handler: reject_task
// ─────────────────────────────────────────────────────────────

async function handleRejectTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const note = readStr(params, "note");
  const caller = await resolveCallerRole(panelId, params);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (task.status !== "reviewing") {
    throw new Error(`任务当前状态 "${task.status}" 不允许 reject_task。`);
  }

  // 只有指定的验收者才能驳回；执行者不能驳回自己的任务
  if (caller.id === task.assigneeRoleId) {
    throw new Error("执行者不能驳回自己的任务。");
  }
  if (task.reviewerRoleId && caller.id !== task.reviewerRoleId) {
    throw new Error(
      `只有指定的验收者（${task.reviewerRoleTitle ?? task.reviewerRoleId}）才能驳回此任务。`,
    );
  }

  await updateGroupTaskField(panelId, taskId, "reviewNote", note || undefined);
  const updated = await updateGroupTaskStatus(panelId, taskId, "rejected", {
    type: "rejected",
    actorRoleId: caller.id,
    actorRoleTitle: caller.title,
    note,
  });

  if (task.assigneeRoleId) {
    const busy = await hasActiveTask(panelId, task.assigneeRoleId);
    if (busy) {
      requeueRejectedTask(task.assigneeRoleId, taskId);
    } else {
      const roles = await listGroupRoles(panelId);
      const assigneeRole = roles.find((r) => r.id === task.assigneeRoleId);
      if (assigneeRole) {
        const taskWithNote = { ...task, reviewNote: note || undefined };
        await dispatchTaskMessage({
          panelId,
          roleId: assigneeRole.id,
          agentId: assigneeRole.agentId,
          text: buildRejectionMessage(taskWithNote),
          taskId,
          isLeader: assigneeRole.isLeader === true,
          roleTitle: assigneeRole.title,
        });
      }
    }
  }

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Handler: block_on
// ─────────────────────────────────────────────────────────────

async function handleBlockOn(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const dependsOnTaskId = readStr(params, "dependsOnTaskId", true);
  const note = readStr(params, "note");
  const caller = await resolveCallerRole(panelId, params);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (task.assigneeRoleId !== caller.id) throw new Error("只有 assignee 才能声明阻塞。");
  if (task.status !== "in_progress") {
    throw new Error(`任务当前状态 "${task.status}" 不允许 block_on。`);
  }

  const depTask = await getGroupTask(panelId, dependsOnTaskId);
  if (!depTask) throw new Error(`前置任务 "${dependsOnTaskId}" 不存在。`);

  if (depTask.status === "done") {
    return { ok: true, message: "前置任务已完成，无需阻塞，请直接继续执行。", task: taskToView(task) };
  }

  const tasks = await readGroupTasks(panelId);
  const cycleError = detectCycle(tasks, taskId, dependsOnTaskId);
  if (cycleError) throw new Error(cycleError);

  await addTaskDependency(panelId, taskId, dependsOnTaskId);
  const updated = await updateGroupTaskStatus(panelId, taskId, "blocked", {
    type: "blocked",
    actorRoleId: caller.id,
    actorRoleTitle: caller.title,
    note,
  });

  // 通知 leader（如果存在）
  const roles = await listGroupRoles(panelId);
  const leader = roles.find((r) => r.isLeader && r.enabled);
  if (leader) {
    await dispatchTaskMessage({
      panelId,
      roleId: leader.id,
      agentId: leader.agentId,
      text: buildBlockedNotificationMessage(task, depTask.title, note),
      isLeader: true,
      roleTitle: leader.title,
    });
  }

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Handler: add_dependency
// ─────────────────────────────────────────────────────────────

async function handleAddDependency(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const dependsOnTaskId = readStr(params, "dependsOnTaskId", true);

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (TASK_TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`任务 "${task.status}" 已是终态，不能追加依赖。`);
  }

  const depTask = await getGroupTask(panelId, dependsOnTaskId);
  if (!depTask) throw new Error(`前置任务 "${dependsOnTaskId}" 不存在。`);

  const tasks = await readGroupTasks(panelId);
  const cycleError = detectCycle(tasks, taskId, dependsOnTaskId);
  if (cycleError) throw new Error(cycleError);

  await addTaskDependency(panelId, taskId, dependsOnTaskId);
  await appendTaskEvent(panelId, taskId, {
    type: "dependency_added",
    actorRoleId: "app",
    actorRoleTitle: "系统",
    note: `追加前置任务：${depTask.title}`,
  });

  const updated = await getGroupTask(panelId, taskId);
  return { ok: true, task: updated ? taskToView(updated) : null };
}

// ─────────────────────────────────────────────────────────────
// Handler: list_tasks / get_task
// ─────────────────────────────────────────────────────────────

async function handleListTasks(panelId: string) {
  const tasks = await readGroupTasks(panelId);
  return { ok: true, tasks: tasks.map(taskToView) };
}

async function handleGetTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  return { ok: true, task: taskToView(task) };
}

// ─────────────────────────────────────────────────────────────
// Handler: cancel_task
// ─────────────────────────────────────────────────────────────

async function handleCancelTask(panelId: string, params: RpcParams) {
  const taskId = readStr(params, "taskId", true);
  const note = readStr(params, "note");

  const task = await getGroupTask(panelId, taskId);
  if (!task) throw new Error(`任务 "${taskId}" 不存在。`);
  if (TASK_TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`任务当前状态 "${task.status}" 已是终态，无法取消。`);
  }

  const updated = await updateGroupTaskStatus(panelId, taskId, "cancelled", {
    type: "cancelled",
    actorRoleId: "user",
    actorRoleTitle: "用户介入",
    note: note || "用户手动取消",
  });

  if (task.assigneeRoleId) {
    await flushPendingDispatch(panelId, task.assigneeRoleId);
  }

  return { ok: true, task: taskToView(updated) };
}

// ─────────────────────────────────────────────────────────────
// Watchdog（由 watchdog.ts 调用）
// ─────────────────────────────────────────────────────────────

export async function watchdogRedispatch(
  panelId: string,
  taskId: string,
): Promise<{ retried: boolean; intervention: boolean }> {
  const task = await getGroupTask(panelId, taskId);
  if (!task || task.status !== "assigned") return { retried: false, intervention: false };

  const MAX_RETRY = 2;
  const newRetryCount = task.watchdogRetryCount + 1;
  await updateGroupTaskField(panelId, taskId, "watchdogRetryCount", newRetryCount);
  await appendTaskEvent(panelId, taskId, {
    type: "watchdog_redispatched",
    actorRoleId: "app",
    actorRoleTitle: "系统（watchdog）",
    note: `第 ${newRetryCount} 次重试`,
  });

  if (newRetryCount >= MAX_RETRY) {
    await updateGroupTaskStatus(panelId, taskId, "needs_intervention", {
      type: "needs_intervention",
      actorRoleId: "app",
      actorRoleTitle: "系统（watchdog）",
      note: `已重试 ${newRetryCount} 次，需要用户介入`,
    });
    log.error("watchdogRedispatch.needsIntervention", new Error("needs_intervention"), { panelId, taskId });
    return { retried: false, intervention: true };
  }

  if (!task.assigneeRoleId) return { retried: false, intervention: false };
  const roles = await listGroupRoles(panelId);
  const assigneeRole = roles.find((r) => r.id === task.assigneeRoleId);
  if (!assigneeRole) return { retried: false, intervention: false };

  await dispatchTaskMessage({
    panelId,
    roleId: assigneeRole.id,
    agentId: assigneeRole.agentId,
    text: buildWatchdogRetryMessage(task, newRetryCount),
    taskId,
    isLeader: assigneeRole.isLeader === true,
    roleTitle: assigneeRole.title,
  });

  log.debug("watchdogRedispatch.retried", { panelId, taskId, retryCount: String(newRetryCount) });
  return { retried: true, intervention: false };
}

/**
 * Watchdog：处理长期卡在 in_progress 的任务。
 *
 * 三种子场景：
 *   A. run 仍在跑（activeRunId 非空 且匹配 busyRoles）→ abort + 重置为 assigned + 重新派发
 *   B. run 已结束（activeRunId 非空 但不在 busyRoles）→ 发提醒，保持 in_progress
 *   C. activeRunId 为 null（进程重启后被清空，run 状态未知）→ 不 abort，直接重置为 assigned + 重新派发
 *
 * watchdogRetryCount >= MAX_RETRY 时置为 needs_intervention。
 */
export async function watchdogCheckInProgress(
  panelId: string,
  taskId: string,
): Promise<{ action: "aborted_redispatched" | "reminder_sent" | "unknown_redispatched" | "intervention" | "skipped" }> {
  const task = await getGroupTask(panelId, taskId);
  if (!task || task.status !== "in_progress") return { action: "skipped" };
  if (!task.assigneeRoleId) return { action: "skipped" };

  const MAX_RETRY = 2;
  const newRetryCount = task.watchdogRetryCount + 1;

  // 判断 run 状态：
  //   activeRunId == null → 进程重启后被清空，run 状态未知（场景 C）
  //   activeRunId != null → 检查 busyRoles 是否仍在跑
  const currentRunId = getRoleCurrentRunId(panelId, task.assigneeRoleId);
  const runStateUnknown = task.activeRunId == null;
  const runStillActive = !runStateUnknown && currentRunId === task.activeRunId;

  const roles = await listGroupRoles(panelId);
  const assigneeRole = roles.find((r) => r.id === task.assigneeRoleId);
  if (!assigneeRole) return { action: "skipped" };

  // ── 先判断是否已达重试上限 ──
  if (newRetryCount >= MAX_RETRY) {
    await updateGroupTaskField(panelId, taskId, "watchdogRetryCount", newRetryCount);
    await updateGroupTaskStatus(panelId, taskId, "needs_intervention", {
      type: "needs_intervention",
      actorRoleId: "app",
      actorRoleTitle: "系统（watchdog）",
      note: `in_progress 超时已重试 ${newRetryCount} 次，需要用户介入`,
    });
    log.error("watchdogCheckInProgress.needsIntervention", new Error("needs_intervention"), {
      panelId,
      taskId,
      runStillActive: String(runStillActive),
      runStateUnknown: String(runStateUnknown),
    });
    return { action: "intervention" };
  }

  await updateGroupTaskField(panelId, taskId, "watchdogRetryCount", newRetryCount);

  if (runStillActive) {
    // ── 场景 A：run 确认在跑且超时，abort 后重新派发 ──
    await abortGroupRoleRun(panelId, task.assigneeRoleId).catch(() => null);

    await updateGroupTaskStatus(panelId, taskId, "assigned", {
      type: "watchdog_in_progress_retry",
      actorRoleId: "app",
      actorRoleTitle: "系统（watchdog）",
      note: `第 ${newRetryCount} 次重试：运行超时已中止，重新派发`,
    });

    await dispatchTaskMessage({
      panelId,
      roleId: assigneeRole.id,
      agentId: assigneeRole.agentId,
      text: buildWatchdogAbortRetryMessage(task, newRetryCount),
      taskId,
      isLeader: assigneeRole.isLeader === true,
      roleTitle: assigneeRole.title,
    });

    log.debug("watchdogCheckInProgress.abortedRedispatched", {
      panelId,
      taskId,
      retryCount: String(newRetryCount),
    });
    return { action: "aborted_redispatched" };

  } else if (runStateUnknown) {
    // ── 场景 C：进程重启后 activeRunId 被清空，run 状态未知 ──
    // 无法 abort（busyRoles 为空），直接重置为 assigned 重新派发
    await updateGroupTaskStatus(panelId, taskId, "assigned", {
      type: "watchdog_in_progress_retry",
      actorRoleId: "app",
      actorRoleTitle: "系统（watchdog）",
      note: `第 ${newRetryCount} 次重试：进程重启后 run 状态未知，重新派发`,
    });

    await dispatchTaskMessage({
      panelId,
      roleId: assigneeRole.id,
      agentId: assigneeRole.agentId,
      text: buildWatchdogAbortRetryMessage(task, newRetryCount),
      taskId,
      isLeader: assigneeRole.isLeader === true,
      roleTitle: assigneeRole.title,
    });

    log.debug("watchdogCheckInProgress.unknownRedispatched", {
      panelId,
      taskId,
      retryCount: String(newRetryCount),
    });
    return { action: "unknown_redispatched" };

  } else {
    // ── 场景 B：activeRunId 有值但 run 已结束，assignee 未调 submit_task ──
    await appendTaskEvent(panelId, taskId, {
      type: "watchdog_in_progress_retry",
      actorRoleId: "app",
      actorRoleTitle: "系统（watchdog）",
      note: `第 ${newRetryCount} 次提醒：运行已结束但任务未提交`,
    });

    await dispatchTaskMessage({
      panelId,
      roleId: assigneeRole.id,
      agentId: assigneeRole.agentId,
      text: buildWatchdogSubmitReminderMessage(task, newRetryCount),
      taskId,
      isLeader: assigneeRole.isLeader === true,
      roleTitle: assigneeRole.title,
    });

    log.debug("watchdogCheckInProgress.reminderSent", {
      panelId,
      taskId,
      retryCount: String(newRetryCount),
    });
    return { action: "reminder_sent" };
  }
}

// ─────────────────────────────────────────────────────────────
// 主分发入口
// ─────────────────────────────────────────────────────────────

export async function dispatchGroupTaskRpc(
  panelId: string,
  action: string,
  params: RpcParams,
) {
  log.debug("dispatchGroupTaskRpc", { panelId, action });

  switch (action) {
    case "create_task":      return handleCreateTask(panelId, params);
    case "start_task":       return handleStartTask(panelId, params);
    case "submit_task":      return handleSubmitTask(panelId, params);
    case "approve_task":     return handleApproveTask(panelId, params);
    case "reject_task":      return handleRejectTask(panelId, params);
    case "block_on":         return handleBlockOn(panelId, params);
    case "add_dependency":   return handleAddDependency(panelId, params);
    case "list_tasks":       return handleListTasks(panelId);
    case "get_task":         return handleGetTask(panelId, params);
    case "cancel_task":      return handleCancelTask(panelId, params);
    default:
      throw new Error(`Unknown group_task action: ${action}`);
  }
}
