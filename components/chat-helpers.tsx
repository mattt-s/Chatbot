/**
 * @file 聊天相关的工具函数集合。
 *
 * 包含文本截断、时间格式化、会话匹配、runId 归一化、
 * 桥接消息过滤、乐观用户消息构建、以及纯文本链接解析等辅助逻辑。
 */
"use client";

import type { ChatEventPayload, MessageView } from "@/lib/types";
import {
  applyChatEventToMessages,
  classifyAttachment,
  normalizeCustomChatTarget,
  randomId,
} from "@/lib/utils";
import {
  isBridgeDeliveryMessagePlaceholder,
} from "@/lib/bridge-delivery";

export { shouldHideBridgeDeliveryNoiseText } from "@/lib/bridge-delivery";


/**
 * 截断文本到指定最大长度，超出部分用省略号替代。
 *
 * @param value - 原始文本
 * @param max - 最大长度，默认 180
 * @returns 截断后的文本
 * @example truncateText("很长的字符串...", 10)
 */
export function truncateText(value: string, max = 180) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * 将时间戳或日期字符串格式化为 "HH:mm:ss"（24 小时制，中文区域）。
 *
 * @param value - ISO 字符串或毫秒时间戳
 * @returns 格式化后的时间标签，如 "14:05:32"
 */
export function formatTimeLabel(value: string | number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

/**
 * 判断 SSE 事件的 sessionKey 是否匹配当前面板的 sessionKey。
 * 会同时尝试原始匹配和 customchat target 归一化后的匹配。
 *
 * @param eventSessionKey - 事件携带的 sessionKey
 * @param panelSessionKey - 面板的 sessionKey
 * @returns 是否匹配
 */
export function matchesPanelSession(
  eventSessionKey: string | null,
  panelSessionKey: string,
  panelKind?: string,
  panelId?: string,
) {
  if (!eventSessionKey) {
    return false;
  }

  if (eventSessionKey === panelSessionKey) {
    return true;
  }

  const eventNorm = normalizeCustomChatTarget(eventSessionKey);

  // 群组面板：任何同面板下角色 session 的事件都应该匹配
  if (panelKind === "group" && panelId && eventNorm === `panel:${panelId}`) {
    return true;
  }

  return eventNorm === panelSessionKey;
}

/**
 * 归一化聊天事件的 runId。
 *
 * 当前端存在 `customchat:UUID` 格式的临时草稿 runId，且收到带真实 Gateway runId 的
 * 终态事件时，将事件的 runId 替换为临时 runId，使其能正确合并到已有的草稿气泡。
 *
 * @param current - 当前消息列表
 * @param event - 收到的聊天事件
 * @param activeRunId - 当前活跃的 runId
 * @returns 可能修改了 runId 的事件副本
 */
export function normalizeChatEventRunId(
  current: MessageView[],
  event: ChatEventPayload,
  activeRunId: string | null,
) {
  if (
    !activeRunId ||
    activeRunId === event.runId ||
    (event.state !== "final" && event.state !== "aborted" && event.state !== "error")
  ) {
    return event;
  }

  // Only normalize when the active draft has a plugin-generated customchat:UUID runId
  // that needs to be upgraded to a real Gateway runId.
  // If activeRunId is already a real Gateway runId (not customchat:*), the incoming
  // event is an independent delivery and must not be merged into the active bubble.
  if (!activeRunId.startsWith("customchat:") || event.runId.startsWith("customchat:")) {
    return event;
  }

  const hasAliasDraft = current.some(
    (message) =>
      message.role === "assistant" &&
      message.runId === activeRunId &&
      message.draft,
  );
  if (!hasAliasDraft) {
    return event;
  }

  return {
    ...event,
    runId: activeRunId,
  };
}

/**
 * 判断一条消息是否为"桥接投递"的空壳气泡。
 *
 * 当 agent 通过 `message` tool 主动发送消息时，Gateway 会产生一个
 * 父级 run 消息（文本为空或 "no"，且无附件、无 runtimeSteps）。
 * 此函数用于在渲染前过滤掉这类真正的空壳，避免在 UI 上显示多余的气泡。
 *
 * @param message - 待检查的消息视图
 * @returns 若为桥接空壳返回 true
 */
export function isBridgeDeliveryMessage(message: MessageView) {
  return isBridgeDeliveryMessagePlaceholder(message);
}

/**
 * 构建乐观更新的用户消息对象。
 *
 * 在消息实际发送到服务端之前，先在本地消息列表中插入该对象以提供即时反馈。
 * 文件附件会通过 `URL.createObjectURL` 生成临时预览 URL。
 *
 * @param input - 包含 id、文本和文件列表的输入
 * @returns 符合 MessageView 结构的用户消息对象
 */
export function buildOptimisticUserMessage(input: {
  id: string;
  text: string;
  files: File[];
  mentionedGroupRoleIds?: string[];
}) {
  const createdAt = new Date().toISOString();
  return {
    id: input.id,
    role: "user" as const,
    text: input.text,
    createdAt,
    attachments: input.files.map((file, index) => ({
      id: `${input.id}:file:${index}`,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: classifyAttachment(file.type || "application/octet-stream"),
      url: URL.createObjectURL(file),
    })),
    runId: null,
    state: null,
    draft: false,
    errorMessage: null,
    stopReason: null,
    usage: null,
    runtimeSteps: [],
    mentionedGroupRoleIds: input.mentionedGroupRoleIds ?? [],
  };
}

type LinkifiedToken = {
  text: string;
  href: string;
};

function trimTrailingLinkPunctuation(value: string) {
  let core = value;
  let suffix = "";
  while (core.length > 0) {
    const tail = core[core.length - 1];
    if (!/[),.;:!?，。；：！？]/.test(tail)) {
      break;
    }
    core = core.slice(0, -1);
    suffix = `${tail}${suffix}`;
  }
  return { core, suffix };
}

function toSafeToken(rawHref: string, displayText: string): LinkifiedToken | null {
  const href = rawHref.startsWith("www.") ? `https://${rawHref}` : rawHref;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return {
      text: displayText,
      href,
    };
  } catch {
    return null;
  }
}

/**
 * 将纯文本中的 URL 和 Markdown 链接转换为可点击的 React 节点数组。
 *
 * 支持 `[文本](url)` 格式的 Markdown 链接以及裸 URL（http/https/www 开头）。
 * 只允许 http/https 协议，自动移除链接尾部的标点符号。
 *
 * @param text - 原始纯文本
 * @returns React 节点数组，包含字符串片段和 `<a>` 元素
 */
export function renderLinkedText(text: string) {
  const tokens: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`]+|www\.[^\s<>"'`]+)/g;
  let lastIndex = 0;
  let key = 0;
  let match = pattern.exec(text);

  while (match) {
    const matchStart = match.index;
    if (matchStart > lastIndex) {
      tokens.push(text.slice(lastIndex, matchStart));
    }

    if (match[1] && match[2]) {
      const token = toSafeToken(match[2], match[1]);
      if (token) {
        tokens.push(
          <a
            key={`lnk:${key++}`}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="text-sky-700 underline decoration-sky-500 underline-offset-2 hover:text-sky-800"
          >
            {token.text}
          </a>,
        );
      } else {
        tokens.push(match[0]);
      }
    } else {
      const raw = match[3] ?? "";
      const { core, suffix } = trimTrailingLinkPunctuation(raw);
      const token = toSafeToken(core, core);
      if (token) {
        tokens.push(
          <a
            key={`lnk:${key++}`}
            href={token.href}
            target="_blank"
            rel="noreferrer"
            className="text-sky-700 underline decoration-sky-500 underline-offset-2 hover:text-sky-800"
          >
            {token.text}
          </a>,
        );
        if (suffix) {
          tokens.push(suffix);
        }
      } else {
        tokens.push(raw);
      }
    }

    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

export { applyChatEventToMessages, randomId };
