/**
 * @module task-mode/ingest
 * 任务模式专属 ingest 处理。
 * 当 panel.groupMode="task" 时，由 customchat-ingest.ts 顶部分流至此。
 * 不走聊天路由，仅处理：
 *   1. leader 回复 → 存消息 + 发 SSE（对话区展示）
 *   2. assignee 回复 → 追加到对应任务的 textOutputs
 *   3. state=final 且任务仍为 assigned → 触发 watchdog 重试
 */
import "server-only";

import crypto from "node:crypto";

import { publishCustomChatEvent } from "@/lib/customchat-events";
import {
  listGroupRoles,
  readGroupTasks,
  setPanelActiveRun,
  upsertAssistantMessage,
  upsertAssistantRuntimeSteps,
} from "@/lib/store";
import { extractGroupRoleIdFromTarget, nowIso } from "@/lib/utils";
import { createLogger } from "@/lib/logger";
import type { ChatEventPayload, StoredPanel } from "@/lib/types";
import type { CustomChatDeliveryInput } from "@/lib/customchat-ingest";
import type { StoredRuntimeStep } from "@/lib/types";
import { appendTaskTextOutput } from "@/lib/task-mode/store";
import { watchdogRedispatch } from "@/lib/task-mode/app-rpc-handlers";

const log = createLogger("task-mode:ingest");

function toStoredRuntimeSteps(
  runId: string,
  steps: CustomChatDeliveryInput["runtimeSteps"],
): StoredRuntimeStep[] {
  return steps.map((step) => {
    const d = step.data ?? {};
    return {
      id: step.id || `${runId}:${step.stream}:${step.ts}`,
      runId,
      ts: step.ts,
      stream: step.stream,
      kind: (typeof d.kind === "string" ? d.kind : "step") as StoredRuntimeStep["kind"],
      title: typeof d.title === "string" ? d.title : step.stream,
      description: typeof d.description === "string" ? d.description : "",
      detail: typeof d.detail === "string" ? d.detail : null,
      status: (typeof d.status === "string" ? d.status : "info") as StoredRuntimeStep["status"],
      raw: d as Record<string, unknown>,
    };
  });
}

/**
 * 任务模式 ingest 主入口。
 * 由 customchat-ingest.ts 在检测到 panel.groupMode="task" 后调用。
 */
export async function ingestTaskModeDelivery(
  panel: StoredPanel,
  parsed: CustomChatDeliveryInput,
  targetHint: string,
) {
  const runId =
    parsed.runId?.trim() ||
    parsed.messageId?.trim() ||
    `customchat:${crypto.randomUUID()}`;

  log.input("ingestTaskModeDelivery", {
    panelId: panel.id,
    runId,
    state: parsed.state,
    textLen: String((parsed.text ?? "").length),
  });

  const groupRoles = await listGroupRoles(panel.id);

  // 解析发送角色
  const groupRoleId = extractGroupRoleIdFromTarget(targetHint) ?? null;
  const senderRole = groupRoleId
    ? groupRoles.find((r) => r.id === groupRoleId)
    : null;
  const isLeader = senderRole?.isLeader === true;

  const text = (parsed.text ?? "").trim();
  const incomingRuntimeSteps = toStoredRuntimeSteps(runId, parsed.runtimeSteps);

  // runtime steps 直接 upsert（无论是否是 leader）
  if (incomingRuntimeSteps.length > 0) {
    await upsertAssistantRuntimeSteps(panel.id, runId, incomingRuntimeSteps);
  }

  // ── 对话区：只展示用户消息和 leader 回复 ──
  const shouldShowInConversation = !groupRoleId || isLeader;

  if (shouldShowInConversation) {
    const stored = await upsertAssistantMessage(panel.id, {
      runId,
      text,
      attachments: [],
      state: parsed.state,
      draft: parsed.state === "delta",
      errorMessage: parsed.errorMessage ?? undefined,
      stopReason: parsed.stopReason ?? undefined,
      usage: parsed.usage ?? undefined,
      seq: parsed.seq ?? null,
      groupRoleId: groupRoleId ?? undefined,
      senderLabel: senderRole?.title ?? undefined,
    });

    if (parsed.state === "delta") {
      await setPanelActiveRun(panel.id, runId).catch(() => null);
    } else if (
      parsed.state === "final" ||
      parsed.state === "aborted" ||
      parsed.state === "error"
    ) {
      await setPanelActiveRun(panel.id, null).catch(() => null);
    }

    if (stored) {
      const payload: ChatEventPayload = {
        runId,
        sessionKey: panel.sessionKey,
        seq: parsed.seq ?? 0,
        state: parsed.state,
        message: { text },
        attachments: stored.attachments,
        runtimeSteps: incomingRuntimeSteps,
        errorMessage: parsed.errorMessage ?? undefined,
        usage: parsed.usage ?? undefined,
        stopReason: parsed.stopReason ?? undefined,
        groupRoleId: groupRoleId ?? undefined,
        senderLabel: senderRole?.title ?? undefined,
      };
      publishCustomChatEvent(payload);
    }
  } else {
    // ── 非 leader 成员回复：追加到任务 textOutputs ──
    if (parsed.state === "final" && text && groupRoleId) {
      await appendTaskTextOutputForRole(panel.id, groupRoleId, senderRole?.title ?? groupRoleId, text, runId);
    }

    // state=final 时检查 watchdog（任务是否仍为 assigned → 无响应）
    if (parsed.state === "final" && groupRoleId) {
      await checkWatchdog(panel.id, groupRoleId, runId);
    }

    // 即使不展示，也要清空 activeRun（防止 delta 状态残留）
    if (parsed.state !== "delta") {
      await setPanelActiveRun(panel.id, null).catch(() => null);
    }
  }

  return {
    ok: true,
    ignored: false as boolean | undefined,
    reason: undefined as string | undefined,
    panelId: panel.id,
    runId,
    sessionKey: panel.sessionKey,
    taskMode: true,
  };
}

/**
 * 将成员文本输出追加到其当前活跃任务的 textOutputs。
 * 通过 activeRunId 精确匹配，若无匹配则退回用角色+状态猜测。
 */
async function appendTaskTextOutputForRole(
  panelId: string,
  roleId: string,
  roleTitle: string,
  text: string,
  runId: string,
) {
  const tasks = await readGroupTasks(panelId);

  // 优先通过 activeRunId 精确匹配
  let targetTask = tasks.find(
    (t) =>
      t.assigneeRoleId === roleId &&
      t.activeRunId === runId &&
      (t.status === "in_progress" || t.status === "submitted"),
  );

  // 退回：找 in_progress 任务
  if (!targetTask) {
    targetTask = tasks.find(
      (t) =>
        t.assigneeRoleId === roleId &&
        t.status === "in_progress",
    );
  }

  if (!targetTask) {
    log.debug("appendTaskTextOutputForRole.noTask", { panelId, roleId, runId });
    return;
  }

  await appendTaskTextOutput(panelId, targetTask.id, {
    roleId,
    roleTitle,
    text,
    runId,
    ts: nowIso(),
  });
}

/**
 * ingest state=final 时，检查是否有 assigned 任务的 activeRunId 匹配本次 runId。
 * 如果匹配，说明 assignee 未调用 start_task → 触发 watchdog 重试。
 */
async function checkWatchdog(
  panelId: string,
  roleId: string,
  runId: string,
) {
  const tasks = await readGroupTasks(panelId);
  const unresponsiveTask = tasks.find(
    (t) =>
      t.assigneeRoleId === roleId &&
      t.status === "assigned" &&
      t.activeRunId === runId,
  );

  if (!unresponsiveTask) return;

  log.debug("checkWatchdog.unresponsive", {
    panelId,
    taskId: unresponsiveTask.id,
    runId,
  });

  void watchdogRedispatch(panelId, unresponsiveTask.id).catch((err) => {
    log.error("checkWatchdog.redispatch", err, { panelId, taskId: unresponsiveTask.id });
  });
}
