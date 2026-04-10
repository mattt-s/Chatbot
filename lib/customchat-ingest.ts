/**
 * customchat 消息摄入模块
 *
 * 负责接收来自 customchat 插件的投递（delivery），执行校验、附件持久化、
 * 消息存储（upsert）以及 SSE 事件发布。是插件→App 数据流的核心入口。
 */
import "server-only";

import crypto from "node:crypto";

import { z } from "zod";

import { publishCustomChatEvent } from "@/lib/customchat-events";
import { shouldHideBridgeDeliveryNoiseText } from "@/lib/bridge-delivery";
import {
  messageMarksGroupTaskCompleted,
  messageMarksGroupTaskInProgress,
  messageMarksGroupTaskWaitingInput,
  messageMarksGroupTaskBlocked,
  messageMarksGroupTaskPendingReview,
  stripGroupTaskMarkers,
} from "@/lib/group-task";
import {
  lookupRoleByRunId,
  onRoleReplyErrorOrAborted,
  onRoleReplyFinal,
  onRoleReplyTerminalWithoutRouting,
} from "@/lib/group-router";
import { createLogger } from "@/lib/logger";
import { extractInstructionText, parseTrailingMentions } from "@/lib/mention-parser";
import {
  findMessageByRunId,
  findPanelRecordByCustomChatTarget,
  listGroupRoles,
  persistDownloadedBuffer,
  setAssistantMessageSessionMeta,
  setGroupPanelTaskState,
  setPanelActiveRun,
  upsertAssistantMessage,
  upsertAssistantRuntimeSteps,
} from "@/lib/store";
import { readProviderSessionStatus } from "@/lib/customchat-provider";
import { extractMessageSessionMeta } from "@/lib/session-status";
import {
  attachmentToView,
  classifyAttachment,
  extractGroupRoleIdFromTarget,
  normalizeCustomChatTarget,
  sanitizeFilename,
  toCustomChatGroupRoleTarget,
} from "@/lib/utils";
import type { ChatEventPayload, StoredAttachment, StoredRuntimeStep } from "@/lib/types";

/** 单个附件的 Zod 校验 schema（base64 或 content 二选一） */
export const customChatAttachmentSchema = z.object({
  name: z.string().min(1),
  mimeType: z.string().min(1).default("application/octet-stream"),
  base64: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
});

/** 单个运行时步骤的 Zod 校验 schema */
export const customChatRuntimeStepSchema = z.object({
  id: z.string().min(1).optional(),
  stream: z.string().min(1),
  ts: z.number().int().min(0),
  data: z.record(z.string(), z.unknown()).default({}),
});

/** customchat 投递消息的完整 Zod 校验 schema，包含 target、文本、状态、附件及运行时步骤 */
export const customChatDeliverySchema = z.object({
  target: z.string().min(1),
  sessionKey: z.string().min(1).optional(),
  runId: z.string().optional(),
  messageId: z.string().optional(),
  seq: z.number().int().min(0).optional(),
  text: z.string().optional().default(""),
  state: z.enum(["delta", "final", "aborted", "error"]).optional().default("final"),
  errorMessage: z.string().optional().nullable(),
  stopReason: z.string().optional().nullable(),
  usage: z.unknown().optional(),
  attachments: z.array(customChatAttachmentSchema).optional().default([]),
  runtimeSteps: z.array(customChatRuntimeStepSchema).optional().default([]),
});

/** 从 customChatDeliverySchema 推导出的投递输入类型 */
export type CustomChatDeliveryInput = z.infer<typeof customChatDeliverySchema>;

const log = createLogger("ingest");

/**
 * 将 base64 编码的附件解码并持久化到磁盘
 * @param {z.infer<typeof customChatAttachmentSchema>[]} items - 待处理的附件列表
 * @returns {Promise<StoredAttachment[]>} 已持久化的附件记录数组
 */
async function materializeAttachments(
  items: z.infer<typeof customChatAttachmentSchema>[],
) {
  const attachments: StoredAttachment[] = [];

  for (const item of items) {
    const encoded = item.base64 || item.content;
    if (!encoded) {
      continue;
    }
    const bytes = Buffer.from(encoded, "base64");
    const attachment = await persistDownloadedBuffer(
      sanitizeFilename(item.name),
      item.mimeType,
      new Uint8Array(bytes),
    );
    attachments.push(attachment);
  }

  return attachments;
}

/**
 * 清洗助手回复文本，移除 NO_REPLY 标记和模型泄露的推理标签
 * @param {string} text - 原始助手回复文本
 * @returns {string} 清洗后的文本
 */
function normalizeAssistantTextForStorage(text: string) {
  let stripped = text.replace(/NO_REPLY/gi, "");

  // Strip reasoning tags that might have leaked from the model/gateway
  stripped = stripped.replace(/<think>[\s\S]*?<\/think>/gi, "");
  stripped = stripped.replace(/<\/?final>/gi, "");

  return stripped.trim();
}

/**
 * 判断一条回复是否为“纯 NO 噪音”。
 * 仅拦截 bare "NO" / "no" 这类无上下文、无附件、无 runtime step 的占位回复，
 * 避免误伤带解释的正常否定答复（例如 "No, because ..."）。
 */
function isStandaloneNoNoise(params: {
  text: string;
  attachmentCount: number;
  runtimeStepCount: number;
}) {
  return (
    /^no$/i.test(params.text.trim()) &&
    params.attachmentCount === 0 &&
    params.runtimeStepCount === 0
  );
}

function isBareNoText(text: string) {
  return /^no$/i.test(text.trim());
}

/**
 * 将投递中的运行时步骤转换为存储格式
 * @param {string} runId - 所属运行 ID
 * @param {z.infer<typeof customChatRuntimeStepSchema>[]} steps - 原始运行时步骤
 * @returns {StoredRuntimeStep[]} 转换后的存储格式步骤数组
 */
function toStoredRuntimeSteps(
  runId: string,
  steps: z.infer<typeof customChatRuntimeStepSchema>[],
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
 * 摄入一条 customchat 投递消息的完整流程：
 * 校验 → 查找面板 → 持久化附件 → upsert 消息 → 管理 activeRun → 发布 SSE 事件
 *
 * @param {unknown} rawPayload - 来自插件的原始投递 JSON
 * @returns {Promise<object>} 处理结果，包含 panelId、runId、sessionKey 等；
 *   若消息被忽略则 ignored=true 并附带原因
 * @throws {Error} target 无法解析或 panel 不存在时抛出
 */
export async function ingestCustomChatDelivery(rawPayload: unknown) {
  const parsed = customChatDeliverySchema.parse(rawPayload);
  const targetHint = parsed.target?.trim() || parsed.sessionKey?.trim() || "";
  const normalizedTarget = normalizeCustomChatTarget(targetHint);

  log.input("ingestCustomChatDelivery", {
    target: targetHint,
    normalizedTarget: normalizedTarget ?? "null",
    runId: parsed.runId ?? "none",
    state: parsed.state,
    textLen: String((parsed.text ?? "").length),
    attachmentCount: String(parsed.attachments.length),
    runtimeStepCount: String(parsed.runtimeSteps.length),
  });

  if (!normalizedTarget) {
    log.error("ingestCustomChatDelivery", new Error("Unsupported target"), { target: targetHint });
    throw new Error("Unsupported customchat target.");
  }

  const panel = await findPanelRecordByCustomChatTarget(normalizedTarget);
  if (!panel) {
    log.error("ingestCustomChatDelivery", new Error("Panel not found"), { target: normalizedTarget });
    throw new Error("Panel not found.");
  }

  const attachments = await materializeAttachments(parsed.attachments);
  const runId =
    parsed.runId?.trim() ||
    parsed.messageId?.trim() ||
    `customchat:${crypto.randomUUID()}`;
  if ((panel.blockedRunIds ?? []).includes(runId)) {
    log.debug("ingestCustomChatDelivery", { result: "blocked", runId, panelId: panel.id });
    return {
      ok: true,
      ignored: true,
      reason: "run blocked",
      panelId: panel.id,
      runId,
      sessionKey: panel.sessionKey,
    };
  }

  const existingMessage = await findMessageByRunId(panel.id, runId);
  const existingTerminalState = existingMessage?.state ?? null;
  const text = normalizeAssistantTextForStorage(parsed.text ?? "");
  const incomingRuntimeSteps = toStoredRuntimeSteps(runId, parsed.runtimeSteps);

  if (
    isStandaloneNoNoise({
      text,
      attachmentCount: attachments.length,
      runtimeStepCount: incomingRuntimeSteps.length,
    }) &&
    !existingMessage
  ) {
    if (parsed.state !== "delta") {
      await setPanelActiveRun(panel.id, null).catch(() => null);
    }
    return {
      ok: true,
      ignored: true,
      reason: "standalone NO ignored",
      panelId: panel.id,
      runId,
      sessionKey: panel.sessionKey,
    };
  }

  // Guard: skip empty deliveries that would create blank bubbles.
  if (!text && attachments.length === 0 && incomingRuntimeSteps.length === 0 && !existingMessage) {
    if (parsed.state !== "delta") {
      await setPanelActiveRun(panel.id, null).catch(() => null);
    }
    return {
      ok: true,
      ignored: true,
      reason: "empty placeholder ignored",
      panelId: panel.id,
      runId,
      sessionKey: panel.sessionKey,
    };
  }

  // If we have runtimeSteps, upsert them into the message record.
  if (incomingRuntimeSteps.length > 0) {
    await upsertAssistantRuntimeSteps(panel.id, runId, incomingRuntimeSteps);
  }

  // Resolve group role context from target or runId mapping
  const groupRoleId =
    extractGroupRoleIdFromTarget(targetHint) ??
    lookupRoleByRunId(runId)?.groupRoleId ??
    null;
  const mappedRole = lookupRoleByRunId(runId);

  let senderLabel: string | null = null;
  let mentionedGroupRoleIds: string[] | undefined;
  let displayText = text;
  let leaderIssuedCompletion = false;
  let leaderIssuedInProgress = false;
  let leaderIssuedWaitingInput = false;
  let leaderIssuedBlocked = false;
  let leaderIssuedPendingReview = false;
  let shouldSuppressBridgeNoiseText = false;
  let senderAgentId: string | null = null;

  if (groupRoleId) {
    const groupRoles = await listGroupRoles(panel.id);
    const role = groupRoles.find((r) => r.id === groupRoleId);
    senderLabel = role?.title ?? null;
    senderAgentId = role?.agentId ?? null;
    leaderIssuedCompletion =
      role?.isLeader === true &&
      parsed.state === "final" &&
      messageMarksGroupTaskCompleted(text);
    leaderIssuedInProgress =
      role?.isLeader === true &&
      parsed.state === "final" &&
      messageMarksGroupTaskInProgress(text);
    leaderIssuedWaitingInput =
      role?.isLeader === true &&
      parsed.state === "final" &&
      messageMarksGroupTaskWaitingInput(text);
    leaderIssuedBlocked =
      role?.isLeader === true &&
      parsed.state === "final" &&
      messageMarksGroupTaskBlocked(text);
    leaderIssuedPendingReview =
      role?.isLeader === true &&
      parsed.state === "final" &&
      messageMarksGroupTaskPendingReview(text);

    if (text) {
      const mentions = parseTrailingMentions(text, groupRoles);
      if (mentions.length > 0) {
        mentionedGroupRoleIds = mentions.map((r) => r.id);
      }
      displayText = stripGroupTaskMarkers(extractInstructionText(text, groupRoles));
    }
  }

  if (text && parsed.state === "final") {
    shouldSuppressBridgeNoiseText = shouldHideBridgeDeliveryNoiseText(
      {
        id: existingMessage?.id ?? `${runId}:candidate`,
        role: "assistant",
        text,
        createdAt: existingMessage?.createdAt ?? new Date().toISOString(),
        runId,
        attachments: [] as StoredAttachment[],
        runtimeSteps: incomingRuntimeSteps,
      },
      undefined,
      undefined,
    );
    if (shouldSuppressBridgeNoiseText || isBareNoText(displayText)) {
      displayText = "";
    }
  }

  const stored = await upsertAssistantMessage(panel.id, {
    runId,
    text: displayText,
    attachments,
    state: parsed.state,
    draft: parsed.state === "delta",
    errorMessage: parsed.errorMessage ?? undefined,
    stopReason: parsed.stopReason ?? undefined,
    usage: parsed.usage ?? undefined,
    seq: parsed.seq ?? null,
    groupRoleId: groupRoleId ?? undefined,
    senderLabel: senderLabel ?? undefined,
    mentionedGroupRoleIds,
  });

  if (!stored) {
    return {
      ok: true,
      ignored: true,
      reason: "run blocked",
      panelId: panel.id,
      runId,
      sessionKey: panel.sessionKey,
    };
  }

  const canonicalRunId = stored.runId?.trim() || runId;
  let sessionMeta = stored.sessionMeta ?? null;

  if (parsed.state === "delta") {
    await setPanelActiveRun(panel.id, canonicalRunId).catch(() => null);
  }

  if (
    parsed.state === "final" ||
    parsed.state === "aborted" ||
    parsed.state === "error"
  ) {
    await setPanelActiveRun(panel.id, null).catch(() => null);

    const inspectionTarget = groupRoleId
      ? toCustomChatGroupRoleTarget(panel.id, groupRoleId)
      : `channel:${panel.id}`;
    const inspectionAgentId = senderAgentId || panel.agentId;
    const statusResult = await readProviderSessionStatus({
      panelId: panel.id,
      agentId: inspectionAgentId,
      target: inspectionTarget,
      runId: canonicalRunId,
    }).catch(() => null);

    sessionMeta = extractMessageSessionMeta({
      statusText: statusResult?.statusText,
    });

    if (sessionMeta) {
      await setAssistantMessageSessionMeta(panel.id, canonicalRunId, sessionMeta).catch(() => null);
    }
  }

  if (groupRoleId && parsed.state === "final") {
    const nextTaskState = leaderIssuedCompletion
      ? "completed"
      : leaderIssuedInProgress
        ? "in_progress"
        : leaderIssuedWaitingInput
          ? "waiting_input"
          : leaderIssuedBlocked
            ? "blocked"
            : leaderIssuedPendingReview
              ? "pending_review"
              : null;
    if (nextTaskState) {
      await setGroupPanelTaskState(panel.id, nextTaskState, "leader").catch(() => null);
    }
  }

  const payload: ChatEventPayload = {
    runId: canonicalRunId,
    sessionKey: panel.sessionKey,
    seq: parsed.seq ?? 0,
    state: parsed.state,
    message: {
      text: displayText,
    },
    attachments: stored.attachments,
    runtimeSteps: incomingRuntimeSteps,
    errorMessage: parsed.errorMessage ?? undefined,
    usage: parsed.usage ?? undefined,
    stopReason: parsed.stopReason ?? undefined,
    groupRoleId: groupRoleId ?? undefined,
    senderLabel: senderLabel ?? undefined,
    mentionedGroupRoleIds,
    sessionMeta,
  };

  publishCustomChatEvent(payload);

  // Group routing: trigger on terminal states
  if (groupRoleId) {
    log.debug("ingestCustomChatDelivery.terminalRoute", {
      panelId: panel.id,
      runId: canonicalRunId,
      state: parsed.state,
      targetHint,
      groupRoleId,
      mappedGroupRoleId: mappedRole?.groupRoleId ?? null,
      mappedPanelId: mappedRole?.panelId ?? null,
      existingTerminalState: existingTerminalState ?? "null",
      textLen: text.length,
    });
    if (parsed.state === "final" && (shouldSuppressBridgeNoiseText || !displayText)) {
      const groupRoles = await listGroupRoles(panel.id);
      void onRoleReplyTerminalWithoutRouting({
        panelId: panel.id,
        groupRoleId,
        runId: canonicalRunId,
        groupRoles,
      });
    } else if (parsed.state === "final" && displayText && existingTerminalState !== "final") {
      const groupRoles = await listGroupRoles(panel.id);
      const role = groupRoles.find((r) => r.id === groupRoleId);
      void onRoleReplyFinal({
        panelId: panel.id,
        panelTitle: panel.title,
        groupRoleId,
        runId: canonicalRunId,
        senderLabel: role?.title ?? "未知角色",
        replyText: displayText,
        mentionedGroupRoleIds,
        groupRoles,
      });
    } else if (
      (parsed.state === "error" && existingTerminalState !== "error") ||
      (parsed.state === "aborted" && existingTerminalState !== "aborted")
    ) {
      void onRoleReplyErrorOrAborted({
        panelId: panel.id,
        groupRoleId,
        runId: canonicalRunId,
      });
    } else if (parsed.state === "aborted" || parsed.state === "error") {
      log.debug("ingestCustomChatDelivery.terminalRoute", {
        panelId: panel.id,
        runId: canonicalRunId,
        state: parsed.state,
        action: "skip-error-aborted-callback",
        reason:
          parsed.state === "aborted"
            ? existingTerminalState === "aborted"
              ? "duplicate-aborted"
              : "groupRoleId-missing"
            : existingTerminalState === "error"
              ? "duplicate-error"
              : "groupRoleId-missing",
      });
    }
  } else if (parsed.state === "final" || parsed.state === "aborted" || parsed.state === "error") {
    log.debug("ingestCustomChatDelivery.terminalRoute", {
      panelId: panel.id,
      runId: canonicalRunId,
      state: parsed.state,
      targetHint,
      groupRoleId: null,
      mappedGroupRoleId: mappedRole?.groupRoleId ?? null,
      mappedPanelId: mappedRole?.panelId ?? null,
      action: "skip-terminal-callback",
      reason: "groupRoleId-missing",
    });
  }

  log.output("ingestCustomChatDelivery", {
    panelId: panel.id,
    runId: canonicalRunId,
    state: parsed.state,
    textLen: String(text.length),
    attachmentCount: String(attachments.length),
  });

  return {
    ok: true,
    panelId: panel.id,
    sessionKey: panel.sessionKey,
    runId: canonicalRunId,
    attachments: attachments.map((attachment) => ({
      id: attachment.id,
      kind: classifyAttachment(attachment.mimeType),
      url: attachmentToView(attachment).url,
    })),
  };
}
