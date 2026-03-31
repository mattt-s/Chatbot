/**
 * @module group-message
 * 群组消息提交模块。
 *
 * 处理用户在群组面板中发送消息的流程：
 * 存储用户消息 → 解析 @mention → 路由转发给对应角色。
 */
import "server-only";

import crypto from "node:crypto";

import { buildAudioAwareInstruction } from "@/lib/audio-instruction";
import { routeMessage } from "@/lib/group-router";
import { createLogger } from "@/lib/logger";
import { extractInstructionText, parseTrailingMentions } from "@/lib/mention-parser";
import {
  appendUserMessage,
  listGroupRoles,
  persistUploadedFile,
  setGroupPanelTaskState,
} from "@/lib/store";
import type { MessageView, SessionUser, StoredPanel } from "@/lib/types";
import { sanitizeFilename } from "@/lib/utils";

const log = createLogger("group-message");

type SubmitGroupMessageInput = {
  user: SessionUser;
  panel: StoredPanel;
  message: string;
  files: File[];
  messageId?: string;
};

type SubmitGroupMessageResult = {
  userMessage: MessageView;
};

/**
 * 提交群组消息的完整流程。
 *
 * 1. 存储用户消息到群组 panel
 * 2. 解析末尾 @mention
 * 3. 路由转发给对应角色（无 @ 则不转发，前端可提示用户）
 *
 * @param {SubmitGroupMessageInput} input - 提交参数
 * @returns {Promise<SubmitGroupMessageResult>} 提交结果
 */
export async function submitGroupMessage(
  input: SubmitGroupMessageInput,
): Promise<SubmitGroupMessageResult> {
  const message = input.message.trim();

  log.input("submitGroupMessage", {
    panelId: input.panel.id,
    userId: input.user.id,
    textLen: String(message.length),
    fileCount: String(input.files.length),
  });

  if (!message && input.files.length === 0) {
    throw new Error("消息不能为空。");
  }

  const messageId = input.messageId?.trim() || crypto.randomUUID();

  // 处理文件上传
  const attachments = [];
  for (const file of input.files) {
    const name = sanitizeFilename(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mimeType = file.type || "application/octet-stream";
    const attachment = await persistUploadedFile({
      userId: input.user.id,
      filename: name,
      mimeType,
      bytes,
    });
    attachments.push(attachment);
  }

  // 获取群组角色列表
  const groupRoles = await listGroupRoles(input.panel.id);
  const mentionedRoles = parseTrailingMentions(message, groupRoles);
  const instructionText = extractInstructionText(message, groupRoles);
  const routedInstructionText = buildAudioAwareInstruction(instructionText, attachments);

  // 存储用户消息
  const userMessage = await appendUserMessage(input.user.id, input.panel.id, {
    id: messageId,
    text: instructionText,
    attachments,
    mentionedGroupRoleIds: mentionedRoles.map((role) => role.id),
  });
  await setGroupPanelTaskState(input.panel.id, "in_progress").catch(() => null);

  // 路由消息
  try {
    await routeMessage({
      panelId: input.panel.id,
      senderType: "user",
      senderLabel: input.user.displayName,
      text: message,
      dispatchInstructionText: routedInstructionText,
      groupRoles,
    });
  } catch (err) {
    log.error("submitGroupMessage", err, {
      panelId: input.panel.id,
      messageId,
    });
    // 路由失败不影响消息已存储的事实
  }

  log.output("submitGroupMessage", {
    panelId: input.panel.id,
    messageId,
  });

  return { userMessage };
}
