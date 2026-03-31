/**
 * @file bridge delivery 噪音识别辅助
 *
 * 统一识别 customchat bridge 中常见的“工具发送完真正结果后，
 * 父 run 尾部又残留一个短文本 NO”的场景。
 */

import type { MessageRole, StoredRuntimeStep } from "@/lib/types";

export const BRIDGE_DELIVERY_NOISE_TEXT_PATTERN = /^no$/i;
export const BRIDGE_DELIVERY_RESULT_WINDOW_MS = 15_000;

type BridgeDeliveryLikeMessage = {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  runId: string | null;
  attachments: Array<unknown>;
  runtimeSteps: StoredRuntimeStep[];
};

export function hasMessageToolRuntimeStep(steps: StoredRuntimeStep[]) {
  return steps.some((step) => {
    const rawTool = typeof step.raw.tool === "string" ? step.raw.tool : "";
    const rawName = typeof step.raw.name === "string" ? step.raw.name : "";
    return rawTool === "message" || rawName === "message";
  });
}

export function isBridgeDeliveryMessagePlaceholder(message: BridgeDeliveryLikeMessage) {
  if (message.role !== "assistant") {
    return false;
  }

  if (message.attachments.length > 0 || message.runtimeSteps.length > 0) {
    return false;
  }

  const trimmed = message.text.trim();
  return trimmed === "" || BRIDGE_DELIVERY_NOISE_TEXT_PATTERN.test(trimmed);
}

export function shouldHideBridgeDeliveryNoiseText(
  message: BridgeDeliveryLikeMessage,
  messages: BridgeDeliveryLikeMessage[] | undefined,
  index: number | undefined,
) {
  if (message.role !== "assistant" || message.attachments.length > 0) {
    return false;
  }

  if (!hasMessageToolRuntimeStep(message.runtimeSteps)) {
    return false;
  }

  const trimmedMessageText = message.text.trim();
  if (!BRIDGE_DELIVERY_NOISE_TEXT_PATTERN.test(trimmedMessageText)) {
    return false;
  }

  if (!messages || typeof index !== "number" || index < 0 || index >= messages.length) {
    return false;
  }

  const currentTs = Date.parse(message.createdAt);
  if (!Number.isFinite(currentTs)) {
    return false;
  }

  return messages.some((candidate, candidateIndex) => {
    if (candidateIndex === index || candidate.role !== "assistant" || candidate.id === message.id) {
      return false;
    }

    const candidateTs = Date.parse(candidate.createdAt);
    if (
      !Number.isFinite(candidateTs) ||
      Math.abs(candidateTs - currentTs) > BRIDGE_DELIVERY_RESULT_WINDOW_MS
    ) {
      return false;
    }

    if (candidate.runId === message.runId) {
      return false;
    }

    const trimmedCandidateText = candidate.text.trim();
    if (trimmedCandidateText === "" && candidate.attachments.length === 0) {
      return false;
    }

    if (candidate.attachments.length > 0) {
      return true;
    }

    if (candidate.runId?.startsWith("customchat:")) {
      return true;
    }

    return candidate.runtimeSteps.length === 0 && trimmedCandidateText.length > 2;
  });
}
