/**
 * @module group-router
 * 群组消息路由核心模块。
 *
 * 职责：
 * 1. 路由：解析消息末尾 @mention，转发给对应角色
 * 2. 排队：目标角色正在推理时，消息入队；推理完成后合并发送
 * 3. 忙闲管理：追踪每个角色的推理状态
 *
 * 所有编排决策（串行/并行、上下文传递、任务拆分）由角色自身驱动。
 */
import "server-only";

import crypto from "node:crypto";

import { abortProviderRun, inspectProviderSession } from "@/lib/customchat-provider";
import { readEffectiveAppSettingsSync } from "@/lib/app-settings";
import { ensureCustomChatBridgeServer, sendInboundToPlugin } from "@/lib/customchat-bridge-server";
import { buildLeaderProgressReminder, GROUP_TASK_REMINDER_AFTER_MS } from "@/lib/group-task";
import { createLogger } from "@/lib/logger";
import {
  buildDispatchMessage,
  extractInstructionText,
  parseTrailingMentions,
} from "@/lib/mention-parser";
import {
  listGroupRoles,
  listInProgressGroupPanels,
  listPanelMessages,
} from "@/lib/store";
import type { StoredGroupRole } from "@/lib/types";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";

const log = createLogger("group-router");

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

interface QueuedMessage {
  senderType: "user" | "group-role";
  senderLabel: string;
  text: string;
  timestamp: number;
}

interface BusyRoleState {
  runId: string;
  agentId: string;
  startedAt: number;
  lastInspectionAt: number | null;
  abortRequestedAt: number | null;
  inspectionInFlight: boolean;
}

const PREQUEUE_VERIFY_AFTER_MS = 15_000;

// ────────────────────────────────────────────
// In-memory state
// ────────────────────────────────────────────

/**
 * 每个角色的消息等待队列
 * key: `${panelId}:${groupRoleId}`
 */
const pendingQueues = new Map<string, QueuedMessage[]>();

/**
 * 当前正在推理的角色集合
 * key: `${panelId}:${groupRoleId}`
 * value: runId
 */
const busyRoles = new Map<string, BusyRoleState>();

/**
 * 记录每个角色是否已注入过群组信息
 * key: `${panelId}:${groupRoleId}`
 */
const initializedRoles = new Set<string>();

/**
 * runId → groupRoleId 映射（供 ingest 回流时查找）
 * key: runId
 */
const runToRoleMap = new Map<string, { panelId: string; groupRoleId: string }>();
const groupReminderState = new Map<string, { lastReminderAt: number }>();

let busyRoleWatchdogTimer: NodeJS.Timeout | null = null;
let taskReminderWatchdogTimer: NodeJS.Timeout | null = null;

// ────────────────────────────────────────────
// Safety limits
// ────────────────────────────────────────────

const SAFETY_LIMITS = {
  /** 每个群组 panel 每分钟最大 dispatch 次数 */
  maxDispatchesPerMinute: 30,
  /** 单个角色的最大队列深度 */
  maxQueueDepth: 10,
};

/**
 * 滑动窗口计数器
 * key: panelId
 */
const dispatchCounters = new Map<string, { count: number; windowStart: number }>();

function checkDispatchLimit(panelId: string): boolean {
  const now = Date.now();
  const counter = dispatchCounters.get(panelId);

  if (!counter || now - counter.windowStart > 60_000) {
    dispatchCounters.set(panelId, { count: 1, windowStart: now });
    return true;
  }

  if (counter.count >= SAFETY_LIMITS.maxDispatchesPerMinute) {
    return false;
  }

  counter.count++;
  return true;
}

function getQueueDepth(panelId: string, groupRoleId: string): number {
  const key = `${panelId}:${groupRoleId}`;
  return pendingQueues.get(key)?.length ?? 0;
}

// ────────────────────────────────────────────
// Busy/Idle management
// ────────────────────────────────────────────

function isRoleBusy(panelId: string, groupRoleId: string): boolean {
  return busyRoles.has(`${panelId}:${groupRoleId}`);
}

function markRoleBusy(panelId: string, groupRoleId: string, runId: string, agentId: string) {
  busyRoles.set(`${panelId}:${groupRoleId}`, {
    runId,
    agentId,
    startedAt: Date.now(),
    lastInspectionAt: null,
    abortRequestedAt: null,
    inspectionInFlight: false,
  });
  log.debug("markRoleBusy", {
    panelId,
    groupRoleId,
    runId,
    agentId,
  });
  ensureBusyRoleWatchdogStarted();
}

export function markRoleIdle(panelId: string, groupRoleId: string, runId?: string) {
  const key = `${panelId}:${groupRoleId}`;
  const current = busyRoles.get(key);
  if (!current) {
    log.debug("markRoleIdle", {
      panelId,
      groupRoleId,
      runId: runId ?? "none",
      released: true,
      reason: "already-idle",
    });
    return true;
  }
  if (runId && current.runId !== runId) {
    log.debug("markRoleIdle", {
      panelId,
      groupRoleId,
      runId,
      currentRunId: current.runId,
      released: false,
      reason: "run-mismatch",
    });
    return false;
  }
  busyRoles.delete(key);
  log.debug("markRoleIdle", {
    panelId,
    groupRoleId,
    runId: runId ?? current.runId,
    currentRunId: current.runId,
    released: true,
    reason: "released",
  });
  return true;
}

// ────────────────────────────────────────────
// First-call tracking
// ────────────────────────────────────────────

function hasBeenInitialized(panelId: string, groupRoleId: string): boolean {
  return initializedRoles.has(`${panelId}:${groupRoleId}`);
}

function markInitialized(panelId: string, groupRoleId: string) {
  initializedRoles.add(`${panelId}:${groupRoleId}`);
}

function ensureBusyRoleWatchdogStarted() {
  if (busyRoleWatchdogTimer) {
    return;
  }

  const intervalMs = readEffectiveAppSettingsSync().groupRoleWatchdogIntervalMs;
  busyRoleWatchdogTimer = setInterval(() => {
    void runBusyRoleWatchdog();
  }, intervalMs);
  busyRoleWatchdogTimer.unref?.();
}

export function ensureGroupTaskReminderWatchdogStarted() {
  if (taskReminderWatchdogTimer) {
    return;
  }

  const intervalMs = readEffectiveAppSettingsSync().groupRoleWatchdogIntervalMs;
  taskReminderWatchdogTimer = setInterval(() => {
    void runGroupTaskReminderWatchdog(Date.now());
  }, intervalMs);
  taskReminderWatchdogTimer.unref?.();
}

export function refreshBusyRoleWatchdog() {
  if (busyRoleWatchdogTimer) {
    clearInterval(busyRoleWatchdogTimer);
    busyRoleWatchdogTimer = null;
  }

  if (busyRoles.size > 0) {
    ensureBusyRoleWatchdogStarted();
  }

  if (taskReminderWatchdogTimer) {
    clearInterval(taskReminderWatchdogTimer);
    taskReminderWatchdogTimer = null;
  }
  ensureGroupTaskReminderWatchdogStarted();
}

async function recoverStaleRole(panelId: string, groupRoleId: string, runId: string) {
  const released = markRoleIdle(panelId, groupRoleId, runId);
  if (!released) {
    return;
  }
  const groupRoles = await listGroupRoles(panelId);
  await flushQueue(panelId, groupRoleId, groupRoles);
}

async function inspectBusyRole(panelId: string, groupRoleId: string, state: BusyRoleState) {
  const key = `${panelId}:${groupRoleId}`;
  const current = busyRoles.get(key);
  if (!current || current.runId !== state.runId || current.inspectionInFlight) {
    return;
  }

  current.inspectionInFlight = true;
  current.lastInspectionAt = Date.now();

  try {
    const target = toCustomChatGroupRoleTarget(panelId, groupRoleId);
    const inspection = await inspectProviderSession({
      panelId,
      agentId: current.agentId,
      target,
      runId: current.runId,
    });

    if (inspection?.exists === false || inspection?.terminal === true) {
      log.debug("watchdog.inspect", {
        panelId,
        groupRoleId,
        runId: current.runId,
        result: inspection?.exists === false ? "missing-session" : "terminal-session",
      });
      await recoverStaleRole(panelId, groupRoleId, current.runId);
    }
  } catch (error) {
    log.error("watchdog.inspect", error, {
      panelId,
      groupRoleId,
      runId: current.runId,
    });
  } finally {
    const latest = busyRoles.get(key);
    if (latest && latest.runId === state.runId) {
      latest.inspectionInFlight = false;
    }
  }
}

async function tryRecoverRoleBeforeQueueing(
  panelId: string,
  groupRoleId: string,
) {
  const key = `${panelId}:${groupRoleId}`;
  const current = busyRoles.get(key);
  if (!current) {
    return false;
  }

  const ageMs = Date.now() - current.startedAt;
  if (ageMs < PREQUEUE_VERIFY_AFTER_MS || current.inspectionInFlight) {
    return false;
  }

  await inspectBusyRole(panelId, groupRoleId, current);
  return !busyRoles.has(key);
}

async function abortBusyRole(panelId: string, groupRoleId: string, state: BusyRoleState) {
  const key = `${panelId}:${groupRoleId}`;
  const current = busyRoles.get(key);
  if (!current || current.runId !== state.runId || current.abortRequestedAt) {
    return;
  }

  current.abortRequestedAt = Date.now();

  try {
    const target = toCustomChatGroupRoleTarget(panelId, groupRoleId);
    await abortProviderRun({
      panelId,
      agentId: current.agentId,
      runId: current.runId,
      target,
    });
    log.debug("watchdog.abort", {
      panelId,
      groupRoleId,
      runId: current.runId,
      result: "requested",
    });
  } catch (error) {
    log.error("watchdog.abort", error, {
      panelId,
      groupRoleId,
      runId: current.runId,
    });
  }
}

export async function abortGroupRoleRun(panelId: string, groupRoleId: string) {
  const key = `${panelId}:${groupRoleId}`;
  const current = busyRoles.get(key);
  if (!current) {
    return {
      status: "idle" as const,
      runId: null,
    };
  }

  if (current.abortRequestedAt) {
    return {
      status: "aborting" as const,
      runId: current.runId,
    };
  }

  current.abortRequestedAt = Date.now();

  try {
    const target = toCustomChatGroupRoleTarget(panelId, groupRoleId);
    const providerAbort = await abortProviderRun({
      panelId,
      agentId: current.agentId,
      runId: current.runId,
      target,
    });

    if (providerAbort?.verified === false) {
      return {
        status: "aborting" as const,
        runId: current.runId,
      };
    }

    const groupRoles = await listGroupRoles(panelId);
    await releaseRoleAndFlushQueue(panelId, groupRoleId, current.runId, groupRoles);

    return {
      status: "aborted" as const,
      runId: current.runId,
    };
  } catch (error) {
    const latest = busyRoles.get(key);
    if (latest && latest.runId === current.runId) {
      latest.abortRequestedAt = null;
    }
    throw error;
  }
}

async function runBusyRoleWatchdog() {
  const settings = readEffectiveAppSettingsSync();
  const now = Date.now();
  const entries = Array.from(busyRoles.entries());
  await Promise.all(entries.map(async ([key, state]) => {
    const [panelId, groupRoleId] = key.split(":");
    if (!panelId || !groupRoleId) {
      return;
    }

    const ageMs = now - state.startedAt;
    if (ageMs >= settings.groupRoleBusyAbortAfterMs) {
      await abortBusyRole(panelId, groupRoleId, state);
      return;
    }

    if (
      ageMs >= settings.groupRoleBusyInspectAfterMs &&
      (!state.lastInspectionAt || now - state.lastInspectionAt >= settings.groupRoleWatchdogIntervalMs)
    ) {
      await inspectBusyRole(panelId, groupRoleId, state);
    }
  }));
}

export function getGroupRoleRuntimeStatuses(panelId: string) {
  const now = Date.now();
  const statuses = new Map<string, {
    runtimeStatus: "idle" | "busy" | "checking" | "aborting";
    activeRunId: string | null;
    busyAgeMs: number | null;
    runtimeSource: "local" | "verified";
    runtimeNote: string | null;
  }>();

  for (const [key, state] of busyRoles.entries()) {
    const [candidatePanelId, groupRoleId] = key.split(":");
    if (candidatePanelId !== panelId || !groupRoleId) {
      continue;
    }

    statuses.set(groupRoleId, {
      runtimeStatus: state.abortRequestedAt
        ? "aborting"
        : state.inspectionInFlight
          ? "checking"
          : "busy",
      activeRunId: state.runId,
      busyAgeMs: Math.max(now - state.startedAt, 0),
      runtimeSource: "local",
      runtimeNote: null,
    });
  }

  return statuses;
}

export async function verifyGroupRoleRuntimeStatuses(
  panelId: string,
  groupRoles: StoredGroupRole[],
) {
  const statuses = getGroupRoleRuntimeStatuses(panelId);

  await Promise.all(
    groupRoles.map(async (role) => {
      const current = statuses.get(role.id);
      if (!current || current.runtimeStatus === "idle") {
        return;
      }

      try {
        const inspection = await inspectProviderSession({
          panelId,
          agentId: role.agentId,
          target: toCustomChatGroupRoleTarget(panelId, role.id),
          runId: current.activeRunId,
        });

        if (inspection?.exists === false || inspection?.terminal === true) {
          const released = markRoleIdle(panelId, role.id, current.activeRunId ?? undefined);
          if (released) {
            await flushQueue(panelId, role.id, groupRoles);
          }
          statuses.set(role.id, {
            runtimeStatus: "idle",
            activeRunId: null,
            busyAgeMs: null,
            runtimeSource: "verified",
            runtimeNote: inspection?.exists === false ? "远端会话不存在" : "远端运行已结束",
          });
          return;
        }

        statuses.set(role.id, {
          ...current,
          runtimeSource: "verified",
          runtimeNote: "已向 gateway 核验",
        });
      } catch (error) {
        log.error("verifyGroupRoleRuntimeStatuses", error, {
          panelId,
          groupRoleId: role.id,
          runId: current.activeRunId ?? "null",
        });
        statuses.set(role.id, {
          ...current,
          runtimeSource: "local",
          runtimeNote: "gateway 核验失败，显示本地状态",
        });
      }
    }),
  );

  return statuses;
}

/**
 * 重置指定面板下所有角色的初始化标记（如角色增删时调用）
 */
export function resetInitializedRoles(panelId: string) {
  for (const key of initializedRoles) {
    if (key.startsWith(`${panelId}:`)) {
      initializedRoles.delete(key);
    }
  }
}

function getPanelBusyRoleCount(panelId: string): number {
  let count = 0;
  for (const key of busyRoles.keys()) {
    if (key.startsWith(`${panelId}:`)) {
      count += 1;
    }
  }
  return count;
}

async function runGroupTaskReminderWatchdog(now: number) {
  const panels = await listInProgressGroupPanels();
  await Promise.all(
    panels.map(async (panel) => {
      const lastReminder = groupReminderState.get(panel.id)?.lastReminderAt ?? 0;
      const messages = await listPanelMessages(panel.id);
      const lastMessageTs = messages.length > 0
        ? new Date(messages[messages.length - 1].createdAt).getTime()
        : panel.taskStateChangedAt
          ? new Date(panel.taskStateChangedAt).getTime()
          : new Date(panel.updatedAt).getTime();
      const lastActivityTs = Math.max(lastMessageTs, lastReminder);

      if (now - lastActivityTs < GROUP_TASK_REMINDER_AFTER_MS) {
        return;
      }

      if (getPanelBusyRoleCount(panel.id) > 0) {
        return;
      }

      const groupRoles = await listGroupRoles(panel.id);
      const leader = groupRoles.find((role) => role.isLeader && role.enabled);
      if (!leader || isRoleBusy(panel.id, leader.id)) {
        return;
      }

      const reminderText = buildLeaderProgressReminder({
        leaderTitle: leader.title,
        memberTitles: groupRoles
          .filter((role) => role.enabled && role.id !== leader.id)
          .map((role) => role.title),
      });

      // Reminder 是系统内部催办消息，不应该重复携带首轮群组注入提示；
      // 即使 app 重启后 initializedRoles 丢失，也始终按非首次消息发送。
      const isFirstCall = false;
      const dispatchText = buildDispatchMessage({
        groupPanel: { id: panel.id, title: panel.title },
        targetRole: leader,
        allRoles: groupRoles,
        sender: { type: "group-role", name: "系统提醒" },
        instruction: reminderText,
        isFirstCall,
      });

      try {
        log.debug("groupTaskReminder", {
          panelId: panel.id,
          leaderId: leader.id,
          idleMs: String(now - lastActivityTs),
          source: messages.length > 0 ? "last-message" : "task-state-changed-at",
        });
        await dispatchToRole({
          panelId: panel.id,
          groupRoleId: leader.id,
          agentId: leader.agentId,
          text: dispatchText,
          allRoles: groupRoles,
          targetRole: leader,
          isFirstCall,
        });
        groupReminderState.set(panel.id, { lastReminderAt: now });
      } catch (error) {
        log.error("groupTaskReminder", error, {
          panelId: panel.id,
          leaderId: leader.id,
        });
      }
    }),
  );
}

// ────────────────────────────────────────────
// runId mapping
// ────────────────────────────────────────────

/**
 * 根据 runId 查找对应的群组角色信息
 */
export function lookupRoleByRunId(runId: string) {
  return runToRoleMap.get(runId) ?? null;
}

// ────────────────────────────────────────────
// Queue management
// ────────────────────────────────────────────

function enqueueMessage(panelId: string, groupRoleId: string, msg: QueuedMessage) {
  const key = `${panelId}:${groupRoleId}`;
  const queue = pendingQueues.get(key) ?? [];
  queue.push(msg);
  pendingQueues.set(key, queue);
}

async function flushQueue(panelId: string, groupRoleId: string, groupRoles: StoredGroupRole[]) {
  const key = `${panelId}:${groupRoleId}`;
  const queue = pendingQueues.get(key);
  if (!queue || queue.length === 0) return;

  // 清空队列
  pendingQueues.delete(key);

  // 合并消息
  const combined = queue
    .map((msg) => `[来自 ${msg.senderLabel}]:\n${msg.text}`)
    .join("\n\n");

  const targetRole = groupRoles.find((r) => r.id === groupRoleId);
  if (!targetRole) return;

  // dispatch 给角色（合并消息不注入首次提示词，因为已有上下文）
  await dispatchToRole({
    panelId,
    groupRoleId,
    agentId: targetRole.agentId,
    text: combined,
    allRoles: groupRoles,
    targetRole,
    isFirstCall: false,
  });
}

async function releaseRoleAndFlushQueue(
  panelId: string,
  groupRoleId: string,
  runId: string,
  groupRoles: StoredGroupRole[],
) {
  const released = markRoleIdle(panelId, groupRoleId, runId);
  if (!released) {
    return false;
  }

  await flushQueue(panelId, groupRoleId, groupRoles);
  return true;
}

// ────────────────────────────────────────────
// Dispatch
// ────────────────────────────────────────────

async function dispatchToRole(params: {
  panelId: string;
  groupRoleId: string;
  agentId: string;
  text: string;
  allRoles: StoredGroupRole[];
  targetRole: StoredGroupRole;
  isFirstCall: boolean;
}) {
  if (!checkDispatchLimit(params.panelId)) {
    log.error("dispatchToRole", new Error("dispatch rate limit exceeded"), {
      panelId: params.panelId,
      groupRoleId: params.groupRoleId,
    });
    return;
  }

  await ensureCustomChatBridgeServer();

  const messageId = crypto.randomUUID();
  const target = toCustomChatGroupRoleTarget(params.panelId, params.groupRoleId);

  log.input("dispatchToRole", {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
    agentId: params.agentId,
    target,
    textLen: String(params.text.length),
    isFirstCall: String(params.isFirstCall),
  });

  const result = await sendInboundToPlugin({
    panelId: params.panelId,
    agentId: params.agentId,
    target,
    messageId,
    text: params.text,
  });

  const runId = result.runId?.trim() || messageId;

  // 标记角色为忙
  markRoleBusy(params.panelId, params.groupRoleId, runId, params.agentId);

  // 记录首次初始化
  if (params.isFirstCall) {
    markInitialized(params.panelId, params.groupRoleId);
  }

  // 记录 runId → groupRoleId 映射
  runToRoleMap.set(runId, {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
  });

  log.output("dispatchToRole", {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
    runId,
  });
}

// ────────────────────────────────────────────
// Core routing
// ────────────────────────────────────────────

/**
 * 路由一条消息：解析末尾 @mention，转发或入队；无 @ 则兜底给 Leader。
 *
 * @param {object} params - 路由参数
 * @param {string} params.panelId - 群组面板 ID
 * @param {"user" | "group-role"} params.senderType - 发送者类型
 * @param {string} params.senderLabel - 发送者名字
 * @param {string} [params.senderGroupRoleId] - 发送者角色 ID（角色回复时）
 * @param {string} params.text - 包含末尾 @mention 的完整文本
 * @param {StoredGroupRole[]} params.groupRoles - 群组内所有角色
 */
export async function routeMessage(params: {
  panelId: string;
  panelTitle?: string;
  senderType: "user" | "group-role";
  senderLabel: string;
  senderGroupRoleId?: string;
  text: string;
  dispatchInstructionText?: string;
  groupRoles: StoredGroupRole[];
}) {
  // 1. 解析末尾 @mention
  const mentions = parseTrailingMentions(params.text, params.groupRoles);
  const instruction =
    params.dispatchInstructionText ??
    extractInstructionText(params.text, params.groupRoles);

  // 2. 确定转发目标
  let targets: StoredGroupRole[];

  if (mentions.length > 0) {
    // 有显式 @mention → 转发给被 @ 的角色（排除发送者自己）
    targets = mentions.filter((r) => r.id !== params.senderGroupRoleId);
  } else {
    // 无显式 @ → 兜底给 Leader（用户消息和角色回复都适用）
    const leader = params.groupRoles.find((r) => r.isLeader && r.enabled);
    if (leader && leader.id !== params.senderGroupRoleId) {
      targets = [leader];
    } else {
      // 没有 Leader，或发送者就是 Leader → 不转发
      return;
    }
  }

  // 3. 对每个目标角色执行转发或入队
  for (const targetRole of targets) {
    const msg: QueuedMessage = {
      senderType: params.senderType,
      senderLabel: params.senderLabel,
      text: instruction,
      timestamp: Date.now(),
    };

    if (isRoleBusy(params.panelId, targetRole.id)) {
      const recovered = await tryRecoverRoleBeforeQueueing(
        params.panelId,
        targetRole.id,
      );
      if (recovered) {
        const isFirstCall = !hasBeenInitialized(params.panelId, targetRole.id);
        const dispatchText = buildDispatchMessage({
          groupPanel: params.panelTitle
            ? { id: params.panelId, title: params.panelTitle }
            : undefined,
          targetRole,
          allRoles: params.groupRoles,
          sender: { type: params.senderType, name: params.senderLabel },
          instruction,
          isFirstCall,
        });

        try {
          await dispatchToRole({
            panelId: params.panelId,
            groupRoleId: targetRole.id,
            agentId: targetRole.agentId,
            text: dispatchText,
            allRoles: params.groupRoles,
            targetRole,
            isFirstCall,
          });
        } catch (err) {
          log.error("routeMessage", err, {
            panelId: params.panelId,
            groupRoleId: targetRole.id,
            action: "dispatch_after_recover",
          });
        }
        continue;
      }

      // 队列深度检查
      if (getQueueDepth(params.panelId, targetRole.id) >= SAFETY_LIMITS.maxQueueDepth) {
        log.error("routeMessage", new Error("queue depth exceeded"), {
          panelId: params.panelId,
          groupRoleId: targetRole.id,
          queueDepth: String(getQueueDepth(params.panelId, targetRole.id)),
        });
        continue;
      }
      enqueueMessage(params.panelId, targetRole.id, msg);
      log.debug("routeMessage", {
        action: "enqueued",
        panelId: params.panelId,
        targetRole: targetRole.title,
      });
    } else {
      const isFirstCall = !hasBeenInitialized(params.panelId, targetRole.id);
      const dispatchText = buildDispatchMessage({
        groupPanel: params.panelTitle
          ? { id: params.panelId, title: params.panelTitle }
          : undefined,
        targetRole,
        allRoles: params.groupRoles,
        sender: { type: params.senderType, name: params.senderLabel },
        instruction,
        isFirstCall,
      });

      try {
        await dispatchToRole({
          panelId: params.panelId,
          groupRoleId: targetRole.id,
          agentId: targetRole.agentId,
          text: dispatchText,
          allRoles: params.groupRoles,
          targetRole,
          isFirstCall,
        });
      } catch (err) {
        log.error("routeMessage", err, {
          panelId: params.panelId,
          groupRoleId: targetRole.id,
        });
        // dispatch 失败 → 角色不会变成"忙"
      }
    }
  }
}

/**
 * 角色回复完成后的处理：标记空闲、路由 @mention、刷出排队消息。
 * 由 customchat-ingest 在 state=final 时调用。
 *
 * @param {object} params - 回调参数
 * @param {string} params.panelId - 群组面板 ID
 * @param {string} params.groupRoleId - 回复完成的角色 ID
 * @param {string} params.senderLabel - 角色名字
 * @param {string} params.replyText - 角色回复的完整文本
 * @param {StoredGroupRole[]} params.groupRoles - 群组内所有角色
 */
export async function onRoleReplyFinal(params: {
  panelId: string;
  panelTitle?: string;
  groupRoleId: string;
  runId: string;
  senderLabel: string;
  replyText: string;
  groupRoles: StoredGroupRole[];
}) {
  log.debug("onRoleReplyFinal", {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
    runId: params.runId,
    senderLabel: params.senderLabel,
    replyTextLen: params.replyText.length,
  });
  // 1. 标记角色为空闲
  const released = markRoleIdle(params.panelId, params.groupRoleId, params.runId);
  if (!released) {
    log.debug("onRoleReplyFinal", {
      panelId: params.panelId,
      groupRoleId: params.groupRoleId,
      runId: params.runId,
      action: "skip-route-and-flush",
      reason: "markRoleIdle-failed",
    });
    return;
  }

  // 2. 路由该回复中的 @mention
  await routeMessage({
    panelId: params.panelId,
    panelTitle: params.panelTitle,
    senderType: "group-role",
    senderLabel: params.senderLabel,
    senderGroupRoleId: params.groupRoleId,
    text: params.replyText,
    groupRoles: params.groupRoles,
  });

  // 3. 刷出该角色的等待队列
  await flushQueue(params.panelId, params.groupRoleId, params.groupRoles);
}

export async function onRoleReplyTerminalWithoutRouting(params: {
  panelId: string;
  groupRoleId: string;
  runId: string;
  groupRoles: StoredGroupRole[];
}) {
  log.debug("onRoleReplyTerminalWithoutRouting", {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
    runId: params.runId,
  });

  const released = await releaseRoleAndFlushQueue(
    params.panelId,
    params.groupRoleId,
    params.runId,
    params.groupRoles,
  );
  if (!released) {
    log.debug("onRoleReplyTerminalWithoutRouting", {
      panelId: params.panelId,
      groupRoleId: params.groupRoleId,
      runId: params.runId,
      action: "skip-flush",
      reason: "markRoleIdle-failed",
    });
  }
}

/**
 * 角色推理失败/中断时的处理：标记空闲，刷出排队消息。
 * 由 customchat-ingest 在 state=error/aborted 时调用。
 */
export async function onRoleReplyErrorOrAborted(params: {
  panelId: string;
  groupRoleId: string;
  runId: string;
}) {
  log.debug("onRoleReplyErrorOrAborted", {
    panelId: params.panelId,
    groupRoleId: params.groupRoleId,
    runId: params.runId,
  });
  const groupRoles = await listGroupRoles(params.panelId);
  const released = await releaseRoleAndFlushQueue(
    params.panelId,
    params.groupRoleId,
    params.runId,
    groupRoles,
  );
  if (!released) {
    log.debug("onRoleReplyErrorOrAborted", {
      panelId: params.panelId,
      groupRoleId: params.groupRoleId,
      runId: params.runId,
      action: "skip-flush",
      reason: "markRoleIdle-failed",
    });
    return;
  }

  return;
}
