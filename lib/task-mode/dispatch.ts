/**
 * @module task-mode/dispatch
 * 任务模式的消息派发模块。
 * 构造标准化 dispatch 消息并通过 Bridge Server 向指定角色发送。
 * 不复用聊天模式的 group-router，完全独立。
 */
import "server-only";

import crypto from "node:crypto";

import {
  ensureCustomChatBridgeServer,
  sendInboundToPlugin,
} from "@/lib/customchat-bridge-server";
import { createLogger } from "@/lib/logger";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import type { StoredGroupTask } from "@/lib/task-mode/types";
import { recordTaskDispatch } from "@/lib/task-mode/store";

const log = createLogger("task-mode:dispatch");

// ─────────────────────────────────────────────────────────────
// 消息模板
// ─────────────────────────────────────────────────────────────

export function buildAssignmentMessage(task: StoredGroupTask): string {
  return [
    `[任务分配] #${task.id.slice(0, 8)} ${task.title}`,
    `描述：${task.description}`,
    `请调用 group_task(start_task, taskId="${task.id}") 认领，完成后调用 group_task(submit_task, taskId="${task.id}", note=...) 提交。`,
  ].join("\n");
}

export function buildRejectionMessage(task: StoredGroupTask): string {
  return [
    `[任务退回] #${task.id.slice(0, 8)} ${task.title}`,
    `退回原因：${task.reviewNote ?? "（未填写）"}`,
    `请修改后重新调用 group_task(start_task, taskId="${task.id}") 认领并再次提交。`,
  ].join("\n");
}

export function buildWatchdogRetryMessage(
  task: StoredGroupTask,
  retryCount: number,
): string {
  return [
    `[任务分配-重试 #${retryCount}] #${task.id.slice(0, 8)} ${task.title}`,
    `注意：上次 dispatch 未收到响应，请确认并认领任务。`,
    `描述：${task.description}`,
    `请调用 group_task(start_task, taskId="${task.id}") 认领，完成后调用 group_task(submit_task, taskId="${task.id}", note=...) 提交。`,
  ].join("\n");
}

export function buildReviewRequestMessage(task: StoredGroupTask): string {
  return [
    `[待验收] #${task.id.slice(0, 8)} ${task.title}`,
    `执行者：${task.assigneeRoleTitle ?? "（未知）"}`,
    `提交说明：${task.submissionNote ?? "（未填写）"}`,
    `请调用 group_task(approve_task, taskId="${task.id}") 或 group_task(reject_task, taskId="${task.id}", note=...) 处理。`,
  ].join("\n");
}

export function buildBlockedNotificationMessage(
  task: StoredGroupTask,
  dependsOnTaskTitle: string,
  note?: string,
): string {
  return [
    `[任务阻塞] #${task.id.slice(0, 8)} ${task.title}`,
    `执行者：${task.assigneeRoleTitle ?? "（未知）"}`,
    note ? `阻塞原因：${note}` : null,
    `等待前置任务："${dependsOnTaskTitle}"`,
    `前置任务完成后将自动恢复分配。`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSubtaskApprovalRequestMessage(task: StoredGroupTask): string {
  return [
    `[子任务待审批] #${task.id.slice(0, 8)} ${task.title}`,
    `提出方：${task.creatorRoleTitle}${task.parentTaskId ? `  父任务：#${task.parentTaskId.slice(0, 8)}` : ""}`,
    `描述：${task.description}`,
    `请调用 group_task(approve_subtask, taskId="${task.id}") 或 group_task(reject_subtask, taskId="${task.id}", note=...) 处理。`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────
// 实际发送
// ─────────────────────────────────────────────────────────────

export interface DispatchResult {
  runId: string;
  messageId: string;
}

/**
 * 向指定角色发送消息，并更新任务的 lastDispatchAt / activeRunId。
 */
export async function dispatchTaskMessage(params: {
  panelId: string;
  roleId: string;
  agentId: string;
  text: string;
  /** 若提供，则将 activeRunId 记录到此 taskId */
  taskId?: string;
}): Promise<DispatchResult> {
  await ensureCustomChatBridgeServer();

  const messageId = crypto.randomUUID();
  const target = toCustomChatGroupRoleTarget(params.panelId, params.roleId);

  log.input("dispatchTaskMessage", {
    panelId: params.panelId,
    roleId: params.roleId,
    taskId: params.taskId ?? "none",
    target,
    textLen: String(params.text.length),
  });

  const result = await sendInboundToPlugin({
    panelId: params.panelId,
    agentId: params.agentId,
    target,
    messageId,
    text: params.text,
    attachments: [],
  });

  const runId = result.runId?.trim() || messageId;

  // 更新任务的 dispatch 记录
  if (params.taskId) {
    await recordTaskDispatch(params.panelId, params.taskId, runId);
  }

  log.output("dispatchTaskMessage", {
    panelId: params.panelId,
    roleId: params.roleId,
    runId,
  });

  return { runId, messageId };
}
