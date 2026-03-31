/**
 * 通用工具函数模块
 *
 * 提供 ID 生成、target 解析、文件名清洗、附件分类、消息格式转换、
 * SSE 事件应用等跨模块复用的纯函数。前后端均可使用（无 server-only）。
 */
import type {
  AttachmentKind,
  AttachmentView,
  ChatEventPayload,
  MessageView,
  StoredAttachment,
  StoredMessage,
  StoredRuntimeStep,
} from "@/lib/types";

/**
 * 返回当前时间的 ISO 8601 字符串
 * @returns {string} ISO 格式时间戳
 * @example nowIso() // "2026-03-19T08:30:00.000Z"
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 生成随机 UUID，优先使用 crypto.randomUUID，逐级降级
 * @returns {string} UUID 格式的随机 ID
 * @example randomId() // "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
 */
export function randomId() {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto?.randomUUID) {
    return maybeCrypto.randomUUID();
  }

  if (maybeCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    maybeCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10, 16).join(""),
    ].join("-");
  }

  return `fallback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构建面板的会话 key
 * @param {string} agentId - Agent ID（当前未使用，保留参数）
 * @param {string} panelId - 面板 ID
 * @returns {string} 会话 key，格式为 "panel:{panelId}"
 */
export function buildSessionKey(agentId: string, panelId: string) {
  void agentId;
  return toCustomChatPanelTarget(panelId);
}

/**
 * 去除 sessionKey 中的 "agent:{agentId}:" 前缀
 * @param {string} sessionKey - 原始 session key
 * @returns {string} 去除前缀后的 key
 * @example stripAgentSessionPrefix("agent:main:panel:abc") // "panel:abc"
 */
export function stripAgentSessionPrefix(sessionKey: string) {
  return sessionKey.replace(/^agent:[^:]+:/, "");
}

/**
 * 将面板 ID 转换为 customchat target 格式
 * @param {string} panelId - 面板 ID
 * @returns {string} "panel:{panelId}"
 */
export function toCustomChatPanelTarget(panelId: string) {
  return `panel:${panelId}`;
}

/**
 * 将群组面板 ID 与群角色 ID 转换为 customchat target 格式
 * @param {string} panelId - 群组面板 ID
 * @param {string} groupRoleId - 群角色 ID
 * @returns {string} "group:direct:{panelId}:role:{groupRoleId}"
 */
export function toCustomChatGroupRoleTarget(panelId: string, groupRoleId: string) {
  return `group:direct:${panelId}:role:${groupRoleId}`;
}

/**
 * 将 sessionKey 转换为回复用的 customchat target
 * @param {string} sessionKey - 会话 key
 * @returns {string} 归一化后的 target 字符串
 */
export function toCustomChatReplyTarget(sessionKey: string) {
  const normalized = normalizeCustomChatTarget(sessionKey);
  return normalized || `panel:${stripAgentSessionPrefix(sessionKey).replace(/^panel-/, "")}`;
}

/**
 * 归一化各种格式的 customchat target 为统一的 "panel:{id}" 格式。
 * 支持 session:、panel:、channel:、direct:、group:、customchat:、agent: 等前缀，递归剥离。
 * @param {string} target - 原始 target 字符串
 * @returns {string | null} 归一化后的 "panel:{id}" 或无法解析时返回 null
 * @example normalizeCustomChatTarget("agent:main:customchat:direct:abc") // "panel:abc"
 * @example normalizeCustomChatTarget("channel:my-panel") // "panel:my-panel"
 */
export function normalizeCustomChatTarget(target: string): string | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("session:")) {
    return normalizeCustomChatTarget(trimmed.slice("session:".length));
  }

  if (trimmed.startsWith("panel:")) {
    const panelId = trimmed.slice("panel:".length).trim();
    return panelId ? `panel:${panelId}` : null;
  }

  if (trimmed.startsWith("channel:")) {
    const channelId = trimmed.slice("channel:".length).trim();
    return channelId ? `panel:${channelId}` : null;
  }

  if (trimmed.startsWith("direct:")) {
    const next = trimmed.slice("direct:".length).trim();
    return next.includes(":") ? normalizeCustomChatTarget(next) : (next ? `panel:${next}` : null);
  }

  if (trimmed.startsWith("grp:")) {
    const match = trimmed.match(/^grp:([^:]+):r:.+$/);
    return match ? `panel:${match[1]}` : null;
  }

  if (trimmed.startsWith("group:")) {
    const roleMatch = trimmed.match(/^group:direct:([^:]+):role:.+$/);
    if (roleMatch) {
      return `panel:${roleMatch[1]}`;
    }
    const next = trimmed.slice("group:".length).trim();
    return next.includes(":") ? normalizeCustomChatTarget(next) : (next ? `panel:${next}` : null);
  }

  if (trimmed.startsWith("customchat:")) {
    const next = trimmed.slice("customchat:".length).trim();
    return next.includes(":") ? normalizeCustomChatTarget(next) : (next ? `panel:${next}` : null);
  }

  if (trimmed.startsWith("agent:")) {
    // Strip agent:<agentId>: and recurse
    const parts = trimmed.split(":");
    if (parts.length >= 3) {
      return normalizeCustomChatTarget(parts.slice(2).join(":"));
    }
  }

  if (/^panel-[a-z0-9-]+$/i.test(trimmed)) {
    return `panel:${trimmed.slice("panel-".length)}`;
  }

  return null;
}

/**
 * 从群角色 target 中提取 groupRoleId
 * @param {string} target - 目标字符串，如 "group:direct:{panelId}:role:{groupRoleId}"
 * @returns {string | null} groupRoleId 或 null
 * @example extractGroupRoleIdFromTarget("group:direct:abc:role:role1") // "role1"
 * @example extractGroupRoleIdFromTarget("panel:abc") // null
 */
export function extractGroupRoleIdFromTarget(target: string): string | null {
  const groupMatch = target.match(/^group:direct:[^:]+:role:(.+)$/);
  if (groupMatch) {
    return groupMatch[1];
  }

  const legacyMatch = target.match(/^grp:[^:]+:r:(.+)$/);
  return legacyMatch?.[1] ?? null;
}

/**
 * 清洗文件名：去除路径部分，只保留安全字符
 * @param {string} filename - 原始文件名（可含路径）
 * @returns {string} 安全的文件名
 * @example sanitizeFilename("../../foo bar.txt") // "foo-bar.txt"
 * @example sanitizeFilename("") // "upload"
 */
export function sanitizeFilename(filename: string) {
  const normalized = filename.split(/[/\\]/).pop() ?? "upload";
  const dotIndex = normalized.lastIndexOf(".");
  const ext = dotIndex > 0 ? normalized.slice(dotIndex) : "";
  const stem = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized;
  const base = stem
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "upload"}${ext}`;
}

/**
 * 根据 MIME 类型将附件分类为 image/audio/video/file
 * @param {string} mimeType - MIME 类型
 * @returns {AttachmentKind} 附件类别
 * @example classifyAttachment("image/png") // "image"
 * @example classifyAttachment("application/pdf") // "file"
 */
export function classifyAttachment(mimeType: string): AttachmentKind {
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  return "file";
}

/**
 * 将字节数格式化为人类可读的字符串
 * @param {number} size - 字节数
 * @returns {string} 格式化后的字符串
 * @example formatBytes(1024) // "1.0 KB"
 * @example formatBytes(1536) // "1.5 KB"
 * @example formatBytes(500) // "500 B"
 */
export function formatBytes(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * 将存储格式的附件转换为前端视图格式
 * @param {StoredAttachment} attachment - 存储格式附件
 * @returns {AttachmentView} 前端视图格式附件（含访问 URL）
 */
export function attachmentToView(attachment: StoredAttachment): AttachmentView {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    url: attachment.sourceUrl ?? `/api/uploads/${attachment.id}`,
    localPath: attachment.storagePath ?? null,
  };
}

/**
 * 判断运行时步骤是否应被过滤（assistant/lifecycle 类型的步骤不显示给用户）
 * @param {StoredRuntimeStep} step - 运行时步骤
 * @returns {boolean} true 表示应忽略
 */
export function isIgnorableStoredRuntimeStep(step: StoredRuntimeStep) {
  const rawType = typeof step.raw.type === "string" ? step.raw.type : "";
  return (
    step.stream === "assistant" ||
    step.stream === "lifecycle" ||
    rawType === "assistant" ||
    rawType === "lifecycle"
  );
}

/**
 * 过滤掉不应显示的运行时步骤
 * @param {StoredRuntimeStep[]} runtimeSteps - 原始步骤数组
 * @returns {StoredRuntimeStep[]} 过滤后的步骤数组
 */
export function sanitizeRuntimeSteps(runtimeSteps: StoredRuntimeStep[]) {
  return runtimeSteps.filter((step) => !isIgnorableStoredRuntimeStep(step));
}

/**
 * 将存储格式消息转换为前端视图格式，同时过滤运行时步骤
 * @param {StoredMessage} message - 存储格式消息
 * @returns {MessageView} 前端视图格式消息
 */
export function messageToView(message: StoredMessage): MessageView {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    attachments: message.attachments.map(attachmentToView),
    runId: message.runId,
    state: message.state,
    draft: message.draft,
    errorMessage: message.errorMessage,
    stopReason: message.stopReason,
    usage: message.usage,
    eventSeq: message.eventSeq ?? null,
    runtimeSteps: sanitizeRuntimeSteps(message.runtimeSteps ?? []),
    groupRoleId: message.groupRoleId ?? null,
    senderLabel: message.senderLabel ?? null,
    mentionedGroupRoleIds: message.mentionedGroupRoleIds ?? [],
    sessionMeta: message.sessionMeta ?? null,
  };
}

/**
 * 将 unknown 值安全转换为 Record 类型
 * @param {unknown} value - 待转换的值
 * @returns {Record<string, unknown> | null} 对象记录或 null
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

/**
 * 从部分附件信息构造完整的 AttachmentView 对象（缺失字段使用默认值）
 */
function toInlineAttachment(
  input: Partial<AttachmentView> & {
    url: string;
    mimeType: string;
  },
): AttachmentView {
  return {
    id: input.id ?? randomId(),
    name: input.name ?? "attachment",
    mimeType: input.mimeType,
    size: input.size ?? 0,
    kind: input.kind ?? classifyAttachment(input.mimeType),
    url: input.url,
  };
}

/**
 * 根据文件路径/URL 的扩展名推断 MIME 类型
 * @param {string} value - 文件路径或 URL
 * @returns {string} 推断出的 MIME 类型，无法识别则返回 "application/octet-stream"
 * @example inferMimeTypeFromPath("photo.png") // "image/png"
 * @example inferMimeTypeFromPath("https://example.com/doc.pdf?v=1") // "application/pdf"
 */
export function inferMimeTypeFromPath(value: string) {
  const clean = value.split("#")[0]?.split("?")[0] ?? value;
  const lower = clean.toLowerCase();

  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";

  return "application/octet-stream";
}

/**
 * 清洗媒体引用字符串：去除引号包裹和尾部标点
 */
function sanitizeMediaRef(raw: string) {
  const trimmed = raw.trim();
  const unwrapped =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;

  return unwrapped.replace(/[),.;]+$/, "").trim();
}

/**
 * 从文本中提取媒体引用：匹配 "MEDIA: url" 行和 Markdown 图片语法 ![](url)
 */
function extractMediaRefsFromText(text: string) {
  const refs = new Set<string>();

  for (const match of text.matchAll(/^\s*MEDIA\s*:\s*(.+?)\s*$/gim)) {
    const value = sanitizeMediaRef(match[1] ?? "");
    if (value) {
      refs.add(value);
    }
  }

  for (const match of text.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    const value = sanitizeMediaRef(match[1] ?? "");
    if (value) {
      refs.add(value);
    }
  }

  return Array.from(refs);
}

/**
 * 从 URL 或文件路径中提取文件名
 * @param {string} url - URL 或文件路径
 * @returns {string} 文件名，无法提取时返回 "attachment"
 * @example filenameFromUrl("https://example.com/files/report.pdf?v=2") // "report.pdf"
 * @example filenameFromUrl("file:///tmp/image.png") // "image.png"
 */
export function filenameFromUrl(url: string) {
  const clean = url.split("#")[0]?.split("?")[0] ?? url;
  const normalized = clean.replace(/^file:\/\//i, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? "attachment";
}

/**
 * 从 source 对象构建 data: URL（支持 media_type+data 和 mimeType+content 两种格式）
 */
function buildDataUrl(source: Record<string, unknown>) {
  if (
    typeof source.media_type === "string" &&
    typeof source.data === "string"
  ) {
    return `data:${source.media_type};base64,${source.data}`;
  }

  if (
    typeof source.mimeType === "string" &&
    typeof source.content === "string"
  ) {
    return `data:${source.mimeType};base64,${source.content}`;
  }

  return null;
}

/**
 * 从消息对象中提取附件列表：支持多部分 content 数组中的 image/source 块，
 * 以及文本中的 MEDIA: 和 Markdown 图片引用
 * @param {unknown} message - 原始消息对象（可能含 text、content 数组等）
 * @returns {AttachmentView[]} 去重后的附件视图数组
 */
export function extractMessageAttachments(message: unknown): AttachmentView[] {
  const record = asRecord(message);
  if (!record) {
    return [];
  }

  const content = record.content;
  const attachments: AttachmentView[] = [];
  const textFragments: string[] = [];

  if (typeof record.text === "string") {
    textFragments.push(record.text);
  }

  if (!Array.isArray(content)) {
    return extractMediaRefsFromText(textFragments.join("\n")).map((mediaRef) => {
      const mimeType = inferMimeTypeFromPath(mediaRef);
      return toInlineAttachment({
        name: filenameFromUrl(mediaRef),
        mimeType,
        kind: classifyAttachment(mimeType),
        url: mediaRef,
      });
    });
  }

  for (const part of content) {
    const contentRecord = asRecord(part);
    if (!contentRecord) {
      continue;
    }

    const type = typeof contentRecord.type === "string" ? contentRecord.type : "";
    if (type === "text") {
      if (typeof contentRecord.text === "string") {
        textFragments.push(contentRecord.text);
      }
      continue;
    }

    const source = asRecord(contentRecord.source);
    const url =
      (source ? buildDataUrl(source) : null) ||
      (source && typeof source.url === "string" ? source.url : null) ||
      (typeof contentRecord.url === "string" ? contentRecord.url : null) ||
      (typeof contentRecord.src === "string" ? contentRecord.src : null);

    if (!url) {
      continue;
    }

    const mimeType =
      (source && typeof source.media_type === "string"
        ? source.media_type
        : null) ||
      (source && typeof source.mimeType === "string" ? source.mimeType : null) ||
      (typeof contentRecord.mimeType === "string" ? contentRecord.mimeType : null) ||
      "application/octet-stream";

    attachments.push(
      toInlineAttachment({
        name:
          typeof contentRecord.name === "string"
            ? contentRecord.name
            : `${type}-attachment`,
        mimeType,
        kind: classifyAttachment(mimeType),
        url,
      }),
    );
  }

  for (const mediaRef of extractMediaRefsFromText(textFragments.join("\n"))) {
    const mimeType = inferMimeTypeFromPath(mediaRef);
    attachments.push(
      toInlineAttachment({
        name: filenameFromUrl(mediaRef),
        mimeType,
        kind: classifyAttachment(mimeType),
        url: mediaRef,
      }),
    );
  }

  const seen = new Set<string>();
  return attachments.filter((attachment) => {
    if (seen.has(attachment.url)) {
      return false;
    }
    seen.add(attachment.url);
    return true;
  });
}

/**
 * 将 URL 转换为本地文件路径（仅支持绝对路径和 file:// 协议）
 * @param {string} url - URL 或路径字符串
 * @returns {string | null} 本地文件绝对路径，非本地路径返回 null
 * @example toLocalFilePath("file:///tmp/a.txt") // "/tmp/a.txt"
 * @example toLocalFilePath("/home/user/file.md") // "/home/user/file.md"
 * @example toLocalFilePath("https://example.com") // null
 */
export function toLocalFilePath(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("/")) {
    return trimmed;
  }

  if (/^[a-zA-Z]:\\/.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("file://")) {
    const raw = trimmed.slice("file://".length);
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded.startsWith("/")) {
        return decoded;
      }
    } catch {
      if (raw.startsWith("/")) {
        return raw;
      }
    }
  }

  return null;
}

/**
 * 从消息对象中提取纯文本内容，支持 text 字段和多部分 content 数组
 * @param {unknown} message - 原始消息对象
 * @returns {string} 提取的文本（已移除 NO_REPLY 标记）
 */
export function extractMessageText(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }

  if (typeof record.text === "string") {
    return record.text.replace(/NO_REPLY/gi, "");
  }

  const content = record.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      const contentRecord = asRecord(part);
      if (!contentRecord) {
        return "";
      }

      if (
        contentRecord.type === "text" &&
        typeof contentRecord.text === "string"
      ) {
        return contentRecord.text.replace(/NO_REPLY/gi, "");
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 将 SSE ChatEvent 应用到消息列表：根据 runId 匹配已有消息进行更新，
 * 或创建新消息。处理 delta/final/aborted/error 四种状态，带 seq 序号去重保护。
 * @param {MessageView[]} messages - 当前消息列表
 * @param {ChatEventPayload} event - SSE 聊天事件
 * @returns {MessageView[]} 更新后的消息列表（按时间排序）
 */
export function applyChatEventToMessages(
  messages: MessageView[],
  event: ChatEventPayload,
) {
  const nextMessages = [...messages];
  const mergeRuntimeSteps = (
    current: StoredRuntimeStep[],
    incoming: StoredRuntimeStep[],
  ) => {
    if (incoming.length === 0) {
      return current;
    }

    const byId = new Map(current.map((step) => [step.id, step] as const));
    for (const step of incoming) {
      if (byId.has(step.id)) {
        const existing = byId.get(step.id)!;
        byId.set(step.id, {
          ...step,
          raw: { ...existing.raw, ...step.raw },
        });
      } else {
        byId.set(step.id, step);
      }
    }
    return Array.from(byId.values()).sort((left, right) => left.ts - right.ts);
  };
  const assistantIndex = nextMessages.findIndex(
    (message) => message.runId === event.runId && message.role === "assistant",
  );
  const text = extractMessageText(event.message);
  const attachments: AttachmentView[] =
    event.attachments && event.attachments.length > 0
      ? event.attachments
      : extractMessageAttachments(event.message);
  const runtimeSteps = sanitizeRuntimeSteps(event.runtimeSteps ?? []);
  const groupMessageFields = {
    groupRoleId: event.groupRoleId ?? null,
    senderLabel: event.senderLabel ?? null,
    mentionedGroupRoleIds: event.mentionedGroupRoleIds ?? [],
  };
  const sessionMeta = event.sessionMeta ?? null;

  if (event.state === "delta") {
    if (assistantIndex >= 0) {
      const existing = nextMessages[assistantIndex];
      const existingSeq = typeof existing.eventSeq === "number" ? existing.eventSeq : -1;
      if (event.seq < existingSeq) {
        return nextMessages.sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        );
      }
      nextMessages[assistantIndex] = {
        ...existing,
        text: text || existing.text,
        attachments:
          attachments.length > 0
            ? attachments
            : existing.attachments,
        runtimeSteps: mergeRuntimeSteps(existing.runtimeSteps, runtimeSteps),
        draft: true,
        state: "delta",
        eventSeq: event.seq,
        groupRoleId: existing.groupRoleId ?? groupMessageFields.groupRoleId,
        senderLabel: existing.senderLabel ?? groupMessageFields.senderLabel,
        mentionedGroupRoleIds:
          groupMessageFields.mentionedGroupRoleIds.length > 0
            ? groupMessageFields.mentionedGroupRoleIds
            : (existing.mentionedGroupRoleIds ?? []),
        sessionMeta: sessionMeta ?? existing.sessionMeta ?? null,
      };
    } else {
      nextMessages.push({
        id: event.runId,
        role: "assistant",
        text,
        createdAt: new Date().toISOString(),
        attachments,
        runId: event.runId,
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        eventSeq: event.seq,
        runtimeSteps,
        ...groupMessageFields,
        sessionMeta,
      });
    }
  } else if (event.state === "final" || event.state === "aborted") {
    if (assistantIndex >= 0) {
      const existingSeq = typeof nextMessages[assistantIndex].eventSeq === "number"
        ? nextMessages[assistantIndex].eventSeq
        : -1;
      if (event.seq < existingSeq) {
        return nextMessages.sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        );
      }
      nextMessages[assistantIndex] = {
        ...nextMessages[assistantIndex],
        text: text || nextMessages[assistantIndex].text,
        attachments:
          attachments.length > 0
            ? attachments
            : nextMessages[assistantIndex].attachments,
        runtimeSteps: mergeRuntimeSteps(
          nextMessages[assistantIndex].runtimeSteps,
          runtimeSteps,
        ),
        draft: false,
        state: event.state,
        stopReason: event.stopReason ?? null,
        usage: event.usage ?? null,
        eventSeq: event.seq,
        groupRoleId:
          nextMessages[assistantIndex].groupRoleId ?? groupMessageFields.groupRoleId,
        senderLabel:
          nextMessages[assistantIndex].senderLabel ?? groupMessageFields.senderLabel,
        mentionedGroupRoleIds:
          groupMessageFields.mentionedGroupRoleIds.length > 0
            ? groupMessageFields.mentionedGroupRoleIds
            : (nextMessages[assistantIndex].mentionedGroupRoleIds ?? []),
        sessionMeta: sessionMeta ?? nextMessages[assistantIndex].sessionMeta ?? null,
      };
    } else {
      nextMessages.push({
        id: event.runId,
        role: "assistant",
        text,
        createdAt: new Date().toISOString(),
        attachments,
        runId: event.runId,
        state: event.state,
        draft: false,
        errorMessage: null,
        stopReason: event.stopReason ?? null,
        usage: event.usage ?? null,
        eventSeq: event.seq,
        runtimeSteps,
        ...groupMessageFields,
        sessionMeta,
      });
    }
  } else if (event.state === "error") {
    if (assistantIndex >= 0) {
      const existingSeq = typeof nextMessages[assistantIndex].eventSeq === "number"
        ? nextMessages[assistantIndex].eventSeq
        : -1;
      if (event.seq < existingSeq) {
        return nextMessages.sort(
          (left, right) =>
            new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
        );
      }
      nextMessages[assistantIndex] = {
        ...nextMessages[assistantIndex],
        runtimeSteps: mergeRuntimeSteps(
          nextMessages[assistantIndex].runtimeSteps,
          runtimeSteps,
        ),
        draft: false,
        state: "error",
        errorMessage: event.errorMessage ?? "Provider returned an error.",
        eventSeq: event.seq,
        groupRoleId:
          nextMessages[assistantIndex].groupRoleId ?? groupMessageFields.groupRoleId,
        senderLabel:
          nextMessages[assistantIndex].senderLabel ?? groupMessageFields.senderLabel,
        mentionedGroupRoleIds:
          groupMessageFields.mentionedGroupRoleIds.length > 0
            ? groupMessageFields.mentionedGroupRoleIds
            : (nextMessages[assistantIndex].mentionedGroupRoleIds ?? []),
        sessionMeta: sessionMeta ?? nextMessages[assistantIndex].sessionMeta ?? null,
      };
    } else {
      nextMessages.push({
        id: event.runId,
        role: "assistant",
        text: "",
        createdAt: new Date().toISOString(),
        attachments,
        runId: event.runId,
        state: "error",
        draft: false,
        errorMessage: event.errorMessage ?? "Provider returned an error.",
        stopReason: null,
        usage: null,
        eventSeq: event.seq,
        runtimeSteps,
        ...groupMessageFields,
        sessionMeta,
      });
    }
  }

  return nextMessages.sort(
    (left, right) =>
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
  );
}
