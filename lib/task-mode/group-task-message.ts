/**
 * @module task-mode/group-task-message
 * 任务模式下用户消息的提交流程。
 *
 * 用户发送消息 → 直接路由给 leader（无 @mention 解析，无 group_route）。
 * 与聊天模式的 group-message.ts 完全独立，不复用 group-router。
 */
import "server-only";

import crypto from "node:crypto";

import { createLogger } from "@/lib/logger";
import {
  appendUserMessage,
  listGroupRoles,
  persistUploadedFile,
} from "@/lib/store";
import type { MessageView, SessionUser, StoredPanel } from "@/lib/types";
import { sanitizeFilename } from "@/lib/utils";
import {
  ensureCustomChatBridgeServer,
  sendInboundToPlugin,
} from "@/lib/customchat-bridge-server";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import {
  isTaskModeFirstDispatch,
  markTaskModeInitialized,
} from "@/lib/task-mode/dispatch";
import fs from "node:fs";
import path from "node:path";

const log = createLogger("task-mode:group-task-message");

const PROMPT_DIR = path.join(process.cwd(), "prompt");

function loadPromptFile(filename: string): string {
  try {
    return fs.readFileSync(path.join(PROMPT_DIR, filename), "utf-8");
  } catch {
    return "";
  }
}

function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

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
// 主入口
// ─────────────────────────────────────────────────────────────

type SubmitGroupTaskMessageInput = {
  user: SessionUser;
  panel: StoredPanel;
  message: string;
  files: File[];
  messageId?: string;
};

type SubmitGroupTaskMessageResult = {
  userMessage: MessageView;
};

/**
 * 任务模式用户消息提交流程。
 *
 * 1. 持久化用户消息
 * 2. 找到 leader 角色
 * 3. 首次调用时注入 leader 提示词
 * 4. 通过 Bridge Server 发送给 leader 的 Gateway 会话
 *
 * @param input - 提交参数
 * @returns 提交结果（含 userMessage 视图）
 */
export async function submitGroupTaskMessage(
  input: SubmitGroupTaskMessageInput,
): Promise<SubmitGroupTaskMessageResult> {
  const messageText = input.message.trim();

  log.input("submitGroupTaskMessage", {
    panelId: input.panel.id,
    userId: input.user.id,
    textLen: String(messageText.length),
    fileCount: String(input.files.length),
  });

  if (!messageText && input.files.length === 0) {
    throw new Error("消息不能为空。");
  }

  await ensureCustomChatBridgeServer();

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

  // 存储用户消息
  const userMessage = await appendUserMessage(input.user.id, input.panel.id, {
    id: messageId,
    text: messageText,
    attachments,
    mentionedGroupRoleIds: [],
  });

  // 找到 leader 角色
  const groupRoles = await listGroupRoles(input.panel.id);
  const leader = groupRoles.find((r) => r.isLeader && r.enabled);

  if (!leader) {
    log.error(
      "submitGroupTaskMessage.noLeader",
      new Error("No leader role found"),
      { panelId: input.panel.id },
    );
    // 无 leader 时仍返回 userMessage，消息已存储
    return { userMessage };
  }

  // 构造发送给 leader 的文本
  // 任务模式下用户消息直接传达，无需 @mention 解析
  let textToSend = messageText;

  // 首次 dispatch：注入 leader 系统提示词（含群内成员列表）
  if (isTaskModeFirstDispatch(input.panel.id, leader.id)) {
    const template = loadPromptFile("group-task-leader.md");
    if (template) {
      const membersList = formatMembersList(groupRoles, leader.id);
      const prompt = applyTemplateVars(template, {
        ROLE_NAME: leader.title,
        GROUP_NAME: input.panel.title,
        MEMBERS_LIST: membersList,
        PANEL_ID: input.panel.id,
      });
      textToSend = `${prompt}\n\n[来自用户]:\n${messageText}`;
    } else {
      textToSend = `[来自用户]:\n${messageText}`;
    }
    markTaskModeInitialized(input.panel.id, leader.id);
  } else {
    textToSend = `[来自用户]:\n${messageText}`;
  }

  const target = toCustomChatGroupRoleTarget(input.panel.id, leader.id);

  try {
    await sendInboundToPlugin({
      panelId: input.panel.id,
      agentId: leader.agentId,
      target,
      messageId,
      text: textToSend,
      attachments,
    });
  } catch (err) {
    log.error("submitGroupTaskMessage.sendFailed", err, {
      panelId: input.panel.id,
      leaderId: leader.id,
    });
    // 发送失败不影响已存储的用户消息
  }

  log.output("submitGroupTaskMessage", {
    panelId: input.panel.id,
    messageId,
    leaderId: leader.id,
  });

  return { userMessage };
}
