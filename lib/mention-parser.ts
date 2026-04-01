/**
 * @module mention-parser
 * 群组消息 @mention 解析与消息构造模块。
 *
 * 提供纯函数：从文本末尾提取 @mention、剥离 @mention 行得到正文、
 * 以及构造发送给角色的消息（含群组上下文注入）。
 */
import {
  GROUP_TASK_COMPLETION_MARKER,
  GROUP_TASK_IN_PROGRESS_MARKER,
} from "@/lib/group-task";
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
 * 只检查最后 3 行，避免误匹配正文中提到的角色名。
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
    if (!lineMentions) {
      break;
    }

    trailingMentionLines.unshift(current);
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
 * 去掉末尾 @mention 行，返回正文部分。
 * 从尾部逐行移除纯 @mention 行和空行。
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
    if (isMentionLine || last === "") {
      lines.pop();
    } else {
      break;
    }
  }

  return lines.join("\n").trim();
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

/**
 * 构造发送给角色的完整消息文本。
 * 首次调用时会注入群组信息、消息规则、Leader 职责等提示词。
 *
 * @param {object} params - 构造参数
 * @param {StoredGroupRole} params.targetRole - 目标角色
 * @param {StoredGroupRole[]} params.allRoles - 群组内所有角色
 * @param {{ type: "user" | "group-role"; name: string }} params.sender - 发送者信息
 * @param {string} params.instruction - 去除 @mention 后的正文
 * @param {boolean} params.isFirstCall - 是否为该角色的首次调用
 * @returns {string} 构造好的消息文本
 */
export function buildDispatchMessage(params: {
  targetRole: StoredGroupRole;
  allRoles: StoredGroupRole[];
  sender: { type: "user" | "group-role"; name: string };
  instruction: string;
  isFirstCall: boolean;
}): string {
  const parts: string[] = [];

  if (params.isFirstCall) {
    // 成员列表（标注组长）
    const others = params.allRoles
      .filter((r) => r.id !== params.targetRole.id && r.enabled)
      .map((r) => (r.isLeader ? `- ${r.title}（组长）` : `- ${r.title}`))
      .join("\n");

    const isLeader = params.targetRole.isLeader === true;
    const roleDesc = isLeader
      ? `你的角色名是「${params.targetRole.title}」，你是本群组的组长。`
      : `你的角色名是「${params.targetRole.title}」。`;

    parts.push(
      `[群组信息]`,
      `你正在一个群组中协作，${roleDesc}`,
      `群组内的其他成员：`,
      others,
      ``,
      `[消息规则]`,
      `1. 你收到的每条消息会标明来源：「用户」或「某个角色名」。`,
      `2. 如果你需要其他成员协助，请在回复的末尾另起一行，写上 @角色名。`,
      `3. 你的回复需要转交给某人时，也请在末尾写 @角色名。`,
      `4. 如果你的回复是最终结果、不需要转发给任何人，则不要在末尾写 @。`,
      `5. 完成其他成员交给你的任务后，务必在末尾 @对方，否则对方无法收到你的回复。`,
      `6. 你只能看到发给你的消息，无法直接看到其他成员之间的对话。`,
      `7. 对话务必简洁扼要，不要任何不必要的寒暄，接到工作任务立即开始执行，不要拖延。`,
      `8. 群成员之间需要共享文件时，直接给出文件的绝对路径，让接收方按该绝对路径访问文件即可。`,

    );

    // Leader 专属职责说明
    if (isLeader) {
      parts.push(
        ``,
        `[组长职责]`,
        `作为组长，当你收到来源不明或未指定接收人的消息时，你需要：`,
        `1. 根据消息内容和上下文判断这条消息的意图。`,
        `2. 如果需要某个成员处理，在你的回复末尾 @该成员。`,
        `3. 如果消息是某个成员的任务完成汇报，理解内容后决定下一步行动。`,
        `4. 如果任务尚未完成，你要主动催促相关成员汇报进度，并给出阶段总结。`,
        `5. 当群任务已经正式开始推进，或你判断接下来还需要继续协作推进时，在回复末尾另起一行输出 ${GROUP_TASK_IN_PROGRESS_MARKER}。`,
        `6. 只有当整个群任务确实完成时，才在回复末尾另起一行输出 ${GROUP_TASK_COMPLETION_MARKER}。`,
        `7. 同一条回复里绝对不要同时输出 ${GROUP_TASK_IN_PROGRESS_MARKER} 和 ${GROUP_TASK_COMPLETION_MARKER}。`,
        `8. 如果你只是回答一个小问题、闲聊、补充说明，且不代表群任务进入或继续推进，就不要输出任何状态标记。`,
      );
    }

    parts.push(
      ``,
      `[回复格式示例]`,
      `这里是你的回复正文。`,
      ``,
      `@角色名`,
      ``,
    );
  }

  const senderLabel =
    params.sender.type === "user" ? "用户" : params.sender.name;
  parts.push(`[来自 ${senderLabel}]:`, params.instruction);

  return parts.join("\n");
}
