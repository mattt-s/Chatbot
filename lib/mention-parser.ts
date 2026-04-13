/**
 * @module mention-parser
 * 群组消息 @mention 解析与消息构造模块。
 *
 * 提供纯函数：从文本末尾 footer 控制块提取 @mention、剥离 footer 控制行得到正文、
 * 以及构造发送给角色的消息（含群组上下文注入）。
 */
import fs from "node:fs";
import path from "node:path";

import type { StoredGroupRole } from "@/lib/types";

/**
 * 转义正则特殊字符
 * @param {string} str - 需要转义的字符串
 * @returns {string} 转义后的字符串
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从文本末尾提取 @mention 的角色列表。
 * 从尾部向上扫描 footer 控制块，允许 @mention 行、任务状态标记行、空行混排；
 * 一旦遇到第一行正文内容就停止，避免误匹配正文中提到的角色名。
 * 按角色名长度降序匹配，防止短名先匹配导致的歧义。
 *
 * @param {string} text - 包含末尾 @mention 的完整文本
 * @param {StoredGroupRole[]} roles - 群组内所有角色
 * @returns {StoredGroupRole[]} 被 @ 到的角色列表
 */
export function parseTrailingMentions(
  text: string,
  roles: StoredGroupRole[],
): StoredGroupRole[] {
  const enabledRoles = roles.filter((r) => r.enabled);
  // 按名字长度降序，防止短名先匹配
  enabledRoles.sort((a, b) => b.title.length - a.title.length);

  const mentioned: StoredGroupRole[] = [];
  const lines = text.trimEnd().split("\n");
  const trailingMentionLines: string[] = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const current = lines[i].trim();
    if (!current) {
      if (trailingMentionLines.length > 0) {
        continue;
      }
      continue;
    }

    const lineMentions = parseMentionLine(current, enabledRoles);
    if (lineMentions) {
      trailingMentionLines.unshift(current);
      continue;
    }

    if (isTaskStateMarkerLine(current)) {
      continue;
    }

    if (!lineMentions) {
      break;
    }
  }

  for (const line of trailingMentionLines) {
    const lineMentions = parseMentionLine(line, enabledRoles) ?? [];
    for (const role of lineMentions) {
      if (!mentioned.some((candidate) => candidate.id === role.id)) {
        mentioned.push(role);
      }
    }
  }

  return mentioned;
}

/**
 * 去掉末尾 footer 控制块，返回正文部分。
 * 从尾部逐行移除纯 @mention 行、任务状态标记行和空行。
 *
 * @param {string} text - 包含末尾 @mention 的完整文本
 * @returns {string} 去除末尾 @ 行后的正文
 */
export function extractInstructionText(
  text: string,
  roles?: StoredGroupRole[],
): string {
  const lines = text.trimEnd().split("\n");
  const enabledRoles = roles?.filter((r) => r.enabled).sort((a, b) => b.title.length - a.title.length);

  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    const isMentionLine = enabledRoles
      ? Boolean(parseMentionLine(last, enabledRoles))
      : /^(@\S+\s*)+$/.test(last);
    if (isMentionLine || isTaskStateMarkerLine(last) || last === "") {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join("\n").trim();
}

function isTaskStateMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === GROUP_TASK_IN_PROGRESS_MARKER ||
    trimmed === GROUP_TASK_COMPLETION_MARKER
  );
}

function parseMentionLine(
  line: string,
  roles: StoredGroupRole[],
): StoredGroupRole[] | null {
  let rest = line.trim();
  if (!rest) return [];

  const matches: StoredGroupRole[] = [];
  while (rest.length > 0) {
    if (!rest.startsWith("@")) return null;

    let matchedRole: StoredGroupRole | null = null;
    let consumed = "";

    for (const role of roles) {
      const pattern = new RegExp(`^@${escapeRegExp(role.title)}(?=\\s|$)`);
      const match = rest.match(pattern);
      if (!match) continue;
      matchedRole = role;
      consumed = match[0];
      break;
    }

    if (!matchedRole) return null;

    matches.push(matchedRole);
    rest = rest.slice(consumed.length).trimStart();
  }

  return matches;
}

const PROMPT_DIR = path.join(process.cwd(), “prompt”);

function loadPromptTemplate(filename: string): string {
  return fs.readFileSync(path.join(PROMPT_DIR, filename), “utf-8”);
}

function applyTemplateVars(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? “”);
}

/**
 * 构造发送给角色的完整消息文本。
 * 首次调用时会注入群组信息、消息规则、Leader 职责等提示词。
 *
 * @param {object} params - 构造参数
 * @param {{ id: string; title: string }} [params.groupPanel] - 当前群组面板信息
 * @param {StoredGroupRole} params.targetRole - 目标角色
 * @param {StoredGroupRole[]} params.allRoles - 群组内所有角色
 * @param {{ type: “user” | “group-role”; name: string }} params.sender - 发送者信息
 * @param {string} params.instruction - 去除 @mention 后的正文
 * @param {boolean} params.isFirstCall - 是否为该角色的首次调用
 * @returns {string} 构造好的消息文本
 */
export function buildDispatchMessage(params: {
  groupPanel?: { id: string; title: string };
  targetRole: StoredGroupRole;
  allRoles: StoredGroupRole[];
  sender: { type: “user” | “group-role”; name: string };
  instruction: string;
  isFirstCall: boolean;
}): string {
  const parts: string[] = [];

  if (params.isFirstCall) {
    const isLeader = params.targetRole.isLeader === true;

    const otherMembers = params.allRoles
      .filter((r) => r.id !== params.targetRole.id && r.enabled)
      .map((r) => (r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`))
      .join(“\n”);

    const groupLocation = params.groupPanel
      ? `群组 ${params.groupPanel.title}（id: ${params.groupPanel.id}）`
      : “一个群组”;

    const commonVars: Record<string, string> = {
      GROUP_LOCATION: groupLocation,
      ROLE_NAME: params.targetRole.title,
      ROLE_LEADER_SUFFIX: isLeader ? “，你是本群组的组长” : “”,
      OTHER_MEMBERS: otherMembers,
    };

    parts.push(applyTemplateVars(loadPromptTemplate(“group-injection-common.md”), commonVars));

    if (isLeader) {
      parts.push(loadPromptTemplate(“group-injection-leader.md”));
    }

    parts.push(“”);
  }

  const senderLabel =
    params.sender.type === “user” ? “用户” : params.sender.name;
  parts.push(`[来自 ${senderLabel}]:`, params.instruction);

  return parts.join(“\n”);
}
