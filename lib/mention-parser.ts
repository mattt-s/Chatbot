/**
 * @module mention-parser
 * 群组消息 @mention 解析与消息构造模块。
 *
 * 提供纯函数：从文本末尾 footer 控制块提取 @mention、剥离 footer 控制行得到正文、
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

/**
 * 构造发送给角色的完整消息文本。
 * 首次调用时会注入群组信息、消息规则、Leader 职责等提示词。
 *
 * @param {object} params - 构造参数
 * @param {{ id: string; title: string }} [params.groupPanel] - 当前群组面板信息
 * @param {StoredGroupRole} params.targetRole - 目标角色
 * @param {StoredGroupRole[]} params.allRoles - 群组内所有角色
 * @param {{ type: "user" | "group-role"; name: string }} params.sender - 发送者信息
 * @param {string} params.instruction - 去除 @mention 后的正文
 * @param {boolean} params.isFirstCall - 是否为该角色的首次调用
 * @returns {string} 构造好的消息文本
 */
export function buildDispatchMessage(params: {
  groupPanel?: { id: string; title: string };
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
    const groupLocation = params.groupPanel
      ? `群组 ${params.groupPanel.title}（id: ${params.groupPanel.id}）`
      : "一个群组";

    parts.push(
      `[群组信息]`,
      `你正在${groupLocation} 中协作，${roleDesc}`,
      `群组内的其他成员：`,
      others,
      ``,
      `[消息规则]`,
      `1. 你收到的每条消息会标明来源：「用户」或「某个角色名」。`,
      `2. 你只能看到发给你的消息，无法直接看到其他成员之间的对话，如果你没有@其他成员，其他成员也看不到你发过的消息，因此有人发给你消息后，你要基于此给其他人分配任务，请务必将收到的消息加工转述给其他人。`,
      `3. 你的回复必须有实际信息价值，只能在以下三种情况回复：交付结果、提出阻塞问题、或明确给出下一步行动。`,
      `4. 不要发送纯确认类回复，例如：“收到”“好的”“明白”“已知悉”“我来处理”。`,
      `5. 如果你已经开始执行，但暂时没有结果、问题或可交付内容，就不要回复。`,
      `6. 只有当你需要其他成员继续行动、回答问题、接收交付结果时，才在回复末尾的 footer 控制块里写 @角色名。`,
      `7. 如果你的回复已经是最终结果，不需要任何人继续处理，则 footer 控制块里不要写 @角色名。`,
      `8. 对话务必简洁扼要，不要寒暄，不要客套，不要重复上下文。`,
      `9. 群成员之间需要共享文件时，直接给出文件的绝对路径，让接收方按该绝对路径访问文件即可。`,
      ``,
      `[回复原则]`,
      `- 有结果就直接给结果。`,
      `- 有阻塞就直接提问。`,
      `- 没有新增信息就不要回复。`,
      `- 不要为了“让别人知道你看到了”而发送消息。`,

    );

    // Leader 专属职责说明
    if (isLeader) {
      parts.push(
        ``,
        `[组长职责]`,
        `1. 你的职责是判断消息意图、分派任务、汇总阶段结果、推动任务收口。`,
        `2. 不要发送纯确认类回复，例如：“收到”“好的”“明白”“已知悉”。`,
        `3. 如果当前没有新增判断、分派、追问或总结，就不要回复。`,
        `4. 只有当你确实需要某个成员继续执行、补充信息、回答问题时，才在 footer 控制块里 @该成员。`,
        `5. 不要为了确认链路、确认收悉、礼貌回应而 @成员。`,
        `6. 如果某个成员已经给出足够结果，而你暂时不需要任何人继续动作，可以直接总结，不要再继续转发。`,
        `7. 当群任务已经正式开始推进，或你判断接下来还需要继续协作推进时，在 footer 控制块里单独另起一行输出 ${GROUP_TASK_IN_PROGRESS_MARKER}。`,
        `8. 只有当整个群任务确实完成时，才在 footer 控制块里单独另起一行输出 ${GROUP_TASK_COMPLETION_MARKER}。`,
        `9. footer 控制块中，@角色行 和任务状态标记行可以任意先后排列，但同一条回复里绝对不要同时输出 ${GROUP_TASK_IN_PROGRESS_MARKER} 和 ${GROUP_TASK_COMPLETION_MARKER}。`,
        `10. 你还负责维护这个群面向用户展示的简洁 Plan。任务有实质推进、阻塞变化、阶段完成时，使用 manage_group_plan 工具更新当前群的 Plan。`,
        `11. Plan 必须简洁，只写当前进度摘要和关键事项，不要把完整讨论过程写进去。`,
        `12. 如果你只是回答一个小问题、闲聊、补充说明，且不代表群任务进入或继续推进，就不要输出任何状态标记，也不要更新 Plan。`,
        ``,
        `[组长处理原则]`,
        `- 用户消息来了：判断谁该处理，再决定是否 @成员。`,
        `- 成员回复来了：先判断这条回复是否包含“结果 / 阻塞 / 需要决策”。`,
        `- 如果成员回复只有确认意义，没有新增信息，不要继续转发，不要继续回应。`,
        `- 只有在需要下一步行动时，才继续分派。`,
        `- 如果已有足够信息，就直接阶段总结或最终总结。`,
      );
    }

    parts.push(
      ``,
      `[回复格式示例]`,
      `这里是你的回复正文。`,
      ``,
      `@角色名`,
    );

    if (isLeader) {
      parts.push(`${GROUP_TASK_IN_PROGRESS_MARKER}`);
    }

    parts.push(``);
  }

  const senderLabel =
    params.sender.type === "user" ? "用户" : params.sender.name;
  parts.push(`[来自 ${senderLabel}]:`, params.instruction);

  return parts.join("\n");
}
