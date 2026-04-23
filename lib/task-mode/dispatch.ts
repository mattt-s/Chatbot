/**
 * @module task-mode/dispatch
 * 任务模式的消息派发模块。
 * 构造标准化 dispatch 消息并通过 Bridge Server 向指定角色发送。
 * 不复用聊天模式的 group-router，完全独立。
 */
import "server-only";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ensureCustomChatBridgeServer,
  sendInboundToPlugin,
} from "@/lib/customchat-bridge-server";
import { createLogger } from "@/lib/logger";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import { listGroupRoles, getPanelTitleById } from "@/lib/store";
import type { StoredGroupTask } from "@/lib/task-mode/types";
import { recordTaskDispatch } from "@/lib/task-mode/store";

const log = createLogger("task-mode:dispatch");

// ─────────────────────────────────────────────────────────────
// First-call tracking（进程内单例，重启后重置）
// ─────────────────────────────────────────────────────────────

declare global {
  var __taskModeInitializedRoles: Set<string> | undefined;
}

function initializedRoles(): Set<string> {
  if (!globalThis.__taskModeInitializedRoles) {
    globalThis.__taskModeInitializedRoles = new Set();
  }
  return globalThis.__taskModeInitializedRoles;
}

export function isTaskModeFirstDispatch(panelId: string, roleId: string): boolean {
  return !initializedRoles().has(`${panelId}:${roleId}`);
}

export function markTaskModeInitialized(panelId: string, roleId: string): void {
  initializedRoles().add(`${panelId}:${roleId}`);
}

// ─────────────────────────────────────────────────────────────
// 提示词加载
// ─────────────────────────────────────────────────────────────

const PROMPT_DIR = path.join(process.cwd(), "prompt");

function loadPromptFile(filename: string): string {
  try {
    return fs.readFileSync(path.join(PROMPT_DIR, filename), "utf-8");
  } catch {
    log.error("loadPromptFile", new Error(`Prompt file not found: ${filename}`), {});
    return "";
  }
}

function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function buildTaskModePrompt(
  isLeader: boolean,
  vars: { roleName: string; groupName: string; membersList: string; panelId: string },
): string {
  const filename = isLeader ? "group-task-leader.md" : "group-task-member.md";
  const template = loadPromptFile(filename);
  if (!template) return "";
  return applyTemplateVars(template, {
    ROLE_NAME: vars.roleName,
    GROUP_NAME: vars.groupName,
    MEMBERS_LIST: vars.membersList,
    PANEL_ID: vars.panelId,
  });
}

/**
 * 将角色列表格式化为提示词中的成员列表文本。
 * 排除目标角色自身，突出显示 leader 身份。
 */
function formatMembersList(
  allRoles: Array<{ id: string; title: string; isLeader?: boolean; enabled: boolean }>,
  excludeRoleId: string,
): string {
  const others = allRoles.filter((r) => r.enabled && r.id !== excludeRoleId);
  if (others.length === 0) return "（暂无其他成员）";
  return others
    .map((r) => (r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`))
    .join("\n");
}

// ─────────────────────────────────────────────────────────────
// 消息模板
// ─────────────────────────────────────────────────────────────

export function buildAssignmentMessage(task: StoredGroupTask): string {
  return [
    `[任务分配] #${task.id.slice(0, 8)} ${task.title}`,
    `描述：${task.description}`,
    `请调用 group_task(action="start_task", taskId="${task.id}") 认领，完成后调用 group_task(action="submit_task", taskId="${task.id}", note=...) 提交。`,
  ].join("\n");
}

export function buildRejectionMessage(task: StoredGroupTask): string {
  return [
    `[任务退回] #${task.id.slice(0, 8)} ${task.title}`,
    `退回原因：${task.reviewNote ?? "（未填写）"}`,
    `请修改后重新调用 group_task(action="start_task", taskId="${task.id}") 认领并再次提交。`,
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
    `请调用 group_task(action="start_task", taskId="${task.id}") 认领，完成后调用 group_task(action="submit_task", taskId="${task.id}", note=...) 提交。`,
  ].join("\n");
}

export function buildReviewRequestMessage(task: StoredGroupTask): string {
  return [
    `[待验收] #${task.id.slice(0, 8)} ${task.title}`,
    `执行者：${task.assigneeRoleTitle ?? "（未知）"}`,
    `提交说明：${task.submissionNote ?? "（未填写）"}`,
    `请调用 group_task(action="approve_task", taskId="${task.id}") 或 group_task(action="reject_task", taskId="${task.id}", note=...) 处理。`,
  ].join("\n");
}

/**
 * Watchdog：运行超时被中止，重新发完整任务（状态已重置为 assigned）。
 */
export function buildWatchdogAbortRetryMessage(
  task: StoredGroupTask,
  retryCount: number,
): string {
  return [
    `[任务重新分配-超时中止 #${retryCount}] #${task.id.slice(0, 8)} ${task.title}`,
    `注意：上次运行超过 10 分钟未完成，已被系统中止并重新分配。`,
    `描述：${task.description}`,
    `请调用 group_task(action="start_task", taskId="${task.id}") 认领，完成后调用 group_task(action="submit_task", taskId="${task.id}", note=...) 提交。`,
  ].join("\n");
}

/**
 * Watchdog：运行已结束但任务未提交，发提醒（任务仍为 in_progress）。
 */
export function buildWatchdogSubmitReminderMessage(
  task: StoredGroupTask,
  retryCount: number,
): string {
  return [
    `[任务提交提醒 #${retryCount}] #${task.id.slice(0, 8)} ${task.title}`,
    `注意：你的上次运行已结束，但任务尚未提交，请尽快完成并提交。`,
    `如任务已完成，请调用 group_task(action="submit_task", taskId="${task.id}", note=...) 提交。`,
    `如遇到阻塞，请调用 group_task(action="block_on", taskId="${task.id}", dependsOnTaskId=...) 声明依赖。`,
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

// ─────────────────────────────────────────────────────────────
// 实际发送
// ─────────────────────────────────────────────────────────────

export interface DispatchResult {
  runId: string;
  messageId: string;
}

/**
 * 向指定角色发送消息，并更新任务的 lastDispatchAt / activeRunId。
 * 首次向某角色发送时自动注入任务模式系统提示词。
 */
export async function dispatchTaskMessage(params: {
  panelId: string;
  roleId: string;
  agentId: string;
  text: string;
  /** 若提供，则将 activeRunId 记录到此 taskId */
  taskId?: string;
  /** 是否为 leader 角色（影响注入的提示词） */
  isLeader?: boolean;
  /** 角色显示名，用于提示词模板 */
  roleTitle?: string;
  /** 群组面板信息，用于提示词模板 */
  groupPanel?: { id: string; title: string };
}): Promise<DispatchResult> {
  await ensureCustomChatBridgeServer();

  const messageId = crypto.randomUUID();
  const target = toCustomChatGroupRoleTarget(params.panelId, params.roleId);

  // ── 首次 dispatch：注入任务模式提示词 ──
  let textToSend = params.text;
  if (isTaskModeFirstDispatch(params.panelId, params.roleId)) {
    // 拉取角色列表和面板标题（仅首次触发，后续不再执行）
    const [allRoles, panelTitle] = await Promise.all([
      listGroupRoles(params.panelId),
      getPanelTitleById(params.panelId),
    ]);

    const membersList = formatMembersList(allRoles, params.roleId);
    const prompt = buildTaskModePrompt(params.isLeader ?? false, {
      roleName: params.roleTitle ?? params.roleId,
      groupName: panelTitle ?? params.groupPanel?.title ?? params.panelId,
      membersList,
      panelId: params.panelId,
    });
    if (prompt) {
      textToSend = `${prompt}\n\n${params.text}`;
    }
    markTaskModeInitialized(params.panelId, params.roleId);
  }

  log.input("dispatchTaskMessage", {
    panelId: params.panelId,
    roleId: params.roleId,
    taskId: params.taskId ?? "none",
    target,
    textLen: String(textToSend.length),
  });

  const result = await sendInboundToPlugin({
    panelId: params.panelId,
    agentId: params.agentId,
    target,
    messageId,
    text: textToSend,
    attachments: [],
  });

  const runId = result.runId?.trim() || messageId;

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
