/**
 * 面板消息提交模块
 *
 * 处理用户在聊天面板中发送消息的完整流程：
 * 文件上传持久化 → 追加用户消息 → 通过 Provider 投递给 Gateway。
 */
import "server-only";

import crypto from "node:crypto";

import { buildAudioAwareInstruction } from "@/lib/audio-instruction";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { appendUserMessage, persistUploadedFile, setPanelActiveRun } from "@/lib/store";
import type { MessageView, SessionUser, StoredAttachment, StoredPanel } from "@/lib/types";
import { sanitizeFilename } from "@/lib/utils";

const log = createLogger("panel-message");

type PreparedUpload = {
  attachment: StoredAttachment;
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  extractedText: string | null;
};

type SubmitPanelMessageInput = {
  user: SessionUser;
  panel: StoredPanel;
  message: string;
  files: File[];
  messageId?: string;
};

type SubmitPanelMessageResult = {
  runId: string | null;
  status: string;
  userMessage: MessageView;
};

type InboundAttachmentInput = {
  name: string;
  mimeType: string;
  content: string;
  size: number;
};

type ProviderIngressPayload = {
  runId?: string;
  status?: string;
  sessionKey?: string;
  error?: string;
};

/**
 * 判断文件是否为类文本文件（可提取文本内容）
 * @param {string} name - 文件名
 * @param {string} mimeType - MIME 类型
 * @returns {boolean} 是否为文本类文件
 */
function isTextLikeFile(name: string, mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".json")
  );
}

/**
 * 处理用户上传的文件：持久化到磁盘并提取文本内容（如适用）
 * @param {string} userId - 上传用户 ID
 * @param {File[]} files - 用户上传的文件列表
 * @returns {Promise<PreparedUpload[]>} 已处理的上传记录数组
 */
async function prepareUploads(userId: string, files: File[]) {
  const uploads: PreparedUpload[] = [];

  for (const file of files) {
    const name = sanitizeFilename(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const attachment = await persistUploadedFile({
      userId,
      filename: name,
      mimeType,
      bytes,
    });

    uploads.push({
      attachment,
      bytes,
      mimeType,
      name,
      extractedText: isTextLikeFile(name, mimeType)
        ? Buffer.from(bytes).toString("utf8").trim().slice(0, 4000) || null
        : null,
    });
  }

  return uploads;
}

/**
 * 构建 Provider 消息入口 URL
 * @returns {string} 完整的入口 URL
 * @throws {Error} 未配置 CUSTOMCHAT_PROVIDER_BASE_URL 时抛出
 */
function buildProviderIngressUrl() {
  const env = getEnv();
  if (!env.providerBaseUrl) {
    throw new Error("CUSTOMCHAT_PROVIDER_BASE_URL is not configured.");
  }

  const baseUrl = env.providerBaseUrl.replace(/\/+$/, "");
  const ingressPath = env.providerIngressPath.startsWith("/")
    ? env.providerIngressPath
    : `/${env.providerIngressPath}`;

  return `${baseUrl}${ingressPath}`;
}

/**
 * 通过 Provider HTTP 接口将用户消息投递给 Gateway
 * @param {StoredPanel} panel - 目标面板
 * @param {string} messageId - 消息唯一 ID
 * @param {string} message - 用户消息文本
 * @param {PreparedUpload[]} uploads - 已处理的附件列表
 * @returns {Promise<{ runId: string; status: string }>} Gateway 返回的 runId 和状态
 * @throws {Error} Provider 请求失败时抛出
 */
async function dispatchViaProvider(
  panel: StoredPanel,
  messageId: string,
  message: string,
  uploads: PreparedUpload[],
) {
  const env = getEnv();
  if (!env.providerToken) {
    throw new Error("CUSTOMCHAT_PROVIDER_TOKEN is not configured.");
  }

  const attachments: InboundAttachmentInput[] = uploads.map((upload) => ({
    name: upload.name,
    mimeType: upload.mimeType,
    content: Buffer.from(upload.bytes).toString("base64"),
    size: upload.bytes.byteLength,
  }));

  const response = await fetch(buildProviderIngressUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.providerToken}`,
    },
    body: JSON.stringify({
      panelId: panel.id,
      agentId: panel.agentId,
      target: `direct:${panel.id}`,
      messageId,
      text: message,
      attachments,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | ProviderIngressPayload
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "custom channel provider request failed.");
  }

  return {
    runId: payload?.runId?.trim() || messageId,
    status: payload?.status?.trim() || "started",
  };
}

/**
 * 提交面板消息的完整流程：校验 → 上传文件 → 存储用户消息 → 投递给 Provider → 设置 activeRun
 * @param {SubmitPanelMessageInput} input - 提交参数（用户、面板、消息文本、文件列表）
 * @returns {Promise<SubmitPanelMessageResult>} 提交结果（用户消息视图、runId、状态）
 * @throws {Error} 空消息或投递失败时抛出
 */
export async function submitPanelMessage(
  input: SubmitPanelMessageInput,
): Promise<SubmitPanelMessageResult> {
  const message = input.message.trim();

  log.input("submitPanelMessage", {
    panelId: input.panel.id,
    agentId: input.panel.agentId,
    userId: input.user.id,
    textLen: String(message.length),
    fileCount: String(input.files.length),
  });

  if (!message && input.files.length === 0) {
    log.debug("submitPanelMessage", { result: "empty message rejected" });
    throw new Error("消息不能为空。");
  }

  const messageId = input.messageId?.trim() || crypto.randomUUID();
  const uploads = await prepareUploads(input.user.id, input.files);
  const providerMessage = buildAudioAwareInstruction(
    message,
    uploads.map((upload) => upload.attachment),
  );
  const userMessage = await appendUserMessage(input.user.id, input.panel.id, {
    id: messageId,
    text: message,
    attachments: uploads.map((upload) => upload.attachment),
  });

  try {
    const delivery = await dispatchViaProvider(
      input.panel,
      messageId,
      providerMessage,
      uploads,
    );
    await setPanelActiveRun(input.panel.id, delivery.runId);

    log.output("submitPanelMessage", {
      panelId: input.panel.id,
      messageId,
      runId: delivery.runId,
      status: delivery.status,
    });

    return {
      userMessage,
      runId: delivery.runId,
      status: delivery.status,
    };
  } catch (err) {
    log.error("submitPanelMessage", err, { panelId: input.panel.id, messageId });
    throw err;
  }
}
