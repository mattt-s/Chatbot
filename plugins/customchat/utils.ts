/**
 * customchat 插件的纯工具函数模块。
 *
 * 本模块包含无副作用的纯函数，不依赖任何外部资源
 * （无 fs、fetch、WebSocket、定时器或可变全局状态）。
 * 主要涵盖：类型定义、文件/路径处理、媒体引用解析、
 * 频道目标归一化、消息载荷提取、会话/Agent 记录处理等。
 */

import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JsonRecord = Record<string, unknown>;

export type AttachmentPayload = {
  name: string;
  mimeType: string;
  base64: string;
};

export type PortalDeliveryState = "delta" | "final" | "aborted" | "error";

export type SessionSnapshot = {
  key: string;
  updatedAtMs: number;
  strings: string[];
  raw: JsonRecord;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * 将未知值安全地转换为 JsonRecord（键值对象）。
 * 如果不是普通对象则返回空对象 `{}`。
 * @param value - 待转换的值
 * @returns 转换后的 JsonRecord
 */
export function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

/**
 * 异步延迟指定毫秒数。
 * @param ms - 延迟毫秒数
 * @returns 延迟完成后 resolve 的 Promise
 */
export function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 对字符串数组去重，保留插入顺序，最多保留 limit 个。
 * @param list - 可能包含 null/undefined 的字符串数组
 * @param limit - 最大保留数量，默认 12
 * @returns 去重后的字符串数组
 */
export function dedupeStrings(list: Array<string | null | undefined>, limit = 12) {
  const next: string[] = [];
  const seen = new Set<string>();

  for (const value of list) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    next.push(trimmed);
    if (next.length >= limit) {
      break;
    }
  }

  return next;
}

/**
 * 将未知值解析为毫秒时间戳。支持数字和可解析的日期字符串。
 * @param value - 待解析的值
 * @returns 毫秒时间戳，解析失败返回 0
 */
export function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

/**
 * 递归收集对象/数组中所有非空字符串值。
 * @param value - 待收集的值（可为嵌套对象或数组）
 * @param depth - 当前递归深度，最大 5 层
 * @param seen - 已访问对象集合，防止循环引用
 * @returns 收集到的字符串数组
 */
export function collectStringValues(
  value: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): string[] {
  if (depth > 5 || value == null) {
    return [] as string[];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (typeof value !== "object" || seen.has(value)) {
    return [] as string[];
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectStringValues(entry, depth + 1, seen));
  }

  return Object.values(value as JsonRecord).flatMap((entry) =>
    collectStringValues(entry, depth + 1, seen),
  );
}

/**
 * 提取字符串值并 trim。非字符串或空白返回空字符串。
 * @param input - 待提取的值
 * @returns trim 后的字符串，或空字符串
 */
export function extractStringValue(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : "";
}

// ---------------------------------------------------------------------------
// File name / path helpers
// ---------------------------------------------------------------------------

/**
 * 清理文件名：去除路径分隔符、替换特殊字符，保留扩展名。
 * @param value - 原始文件名或路径
 * @returns 安全的文件名
 */
export function sanitizeFilename(value: string) {
  const normalized = value.split(/[/\\]/).pop() ?? "attachment";
  const dotIndex = normalized.lastIndexOf(".");
  const ext = dotIndex > 0 ? normalized.slice(dotIndex) : "";
  const stem = dotIndex > 0 ? normalized.slice(0, dotIndex) : normalized;
  const base = stem
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "attachment"}${ext}`;
}

/**
 * 归一化路径片段：将路径分隔符替换为下划线，连续点号压缩。
 * @param value - 原始路径片段
 * @param fallback - 空值时的回退字符串
 * @returns 归一化后的路径片段
 */
export function normalizePathSegment(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  return trimmed.replace(/[\\/]+/g, "_").replace(/\.\.+/g, ".");
}

/**
 * 从文件路径中提取文件名。
 * @param value - 文件路径
 * @returns 文件名，默认 "attachment"
 */
export function fileNameFromPath(value: string): string {
  const normalized = value.split(/[\\/]/).filter(Boolean);
  return normalized[normalized.length - 1] || "attachment";
}

/**
 * 从 URL 中提取文件名，去除查询参数和锚点。
 * @param value - URL 字符串
 * @returns 文件名，默认 "attachment"
 */
export function filenameFromUrl(value: string): string {
  const clean = value.split("#")[0]?.split("?")[0] ?? value;
  const normalized = clean.replace(/^file:\/\//i, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || "attachment";
}

/**
 * 根据文件扩展名推断 MIME 类型。
 * @param value - 文件名或路径
 * @returns MIME 类型字符串，未知扩展名返回 "application/octet-stream"
 */
export function inferMimeType(value: string): string {
  const ext = path.extname(value).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/**
 * 从 URL 推断 MIME 类型（先去除查询参数和锚点）。
 * @param value - URL 字符串
 * @returns MIME 类型字符串
 */
export function inferMimeTypeFromUrl(value: string) {
  return inferMimeType(value.split("#")[0]?.split("?")[0] ?? value);
}

/**
 * 根据文件扩展名猜测图片 MIME 类型。
 * @param filePath - 文件路径
 * @returns 图片 MIME 类型，非图片返回 "application/octet-stream"
 */
export function guessImageMimeType(filePath: string) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

// ---------------------------------------------------------------------------
// URL / path detection
// ---------------------------------------------------------------------------

/**
 * 尝试将字符串解析为本地文件路径。
 * 支持绝对路径、Windows 路径和 file:// 协议。
 * @param value - 待解析的字符串
 * @returns 本地文件路径，无法识别时返回 null
 */
export function toLocalFilePath(value: string): string | null {
  const trimmed = value.trim();
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
 * 判断字符串是否为 HTTP/HTTPS URL。
 * @param value - 待判断的字符串
 * @returns 是否为 HTTP URL
 */
export function isHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * 判断字符串是否为 data: URL。
 * @param value - 待判断的字符串
 * @returns 是否为 data URL
 */
export function isDataUrl(value: string) {
  return /^data:/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Media text extraction
// ---------------------------------------------------------------------------

/**
 * 清理媒体引用字符串：去除包裹的引号和尾部标点。
 * @param raw - 原始媒体引用
 * @returns 清理后的引用字符串
 */
export function sanitizeMediaRef(raw: string) {
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
 * 从文本中提取媒体引用（支持 `MEDIA:` 行和 Markdown 图片语法）。
 * @param text - 待解析的文本
 * @returns 去重后的媒体引用数组
 */
export function extractMediaRefsFromText(text: string) {
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
 * 从文本中移除 `MEDIA:` 行，压缩多余空行。
 * @param text - 原始文本
 * @returns 移除媒体引用后的文本
 */
export function stripMediaRefsFromText(text: string) {
  return text
    .replace(/^\s*MEDIA\s*:\s*.+?\s*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 判断文件是否为文本类文件（可提取文本内容）。
 * @param name - 文件名
 * @param mimeType - MIME 类型
 * @returns 是否为文本类文件
 */
export function isTextLikeFile(name: string, mimeType: string) {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".json")
  );
}

/**
 * 将嵌套的媒体输入扁平化为一维数组。
 * @param input - 可能嵌套的媒体输入
 * @returns 扁平化后的数组
 */
export function flattenMediaInputs(input: unknown): unknown[] {
  if (!input) {
    return [];
  }

  if (!Array.isArray(input)) {
    return [input];
  }

  const flattened: unknown[] = [];
  for (const item of input) {
    flattened.push(...flattenMediaInputs(item));
  }
  return flattened;
}

// ---------------------------------------------------------------------------
// Channel target normalization
// ---------------------------------------------------------------------------

/**
 * 归一化频道目标标识符。
 * 递归剥离 `session:`、`panel:`、`channel:`、`group:`、`customchat:`、`agent:` 等前缀，
 * 最终返回 `direct:<id>` 格式，或无法识别时返回 null。
 * @param value - 原始目标字符串
 * @returns 归一化后的目标（如 `direct:xxx`），或 null
 */
export function normalizeChannelTarget(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  // grp: 前缀透传（群组角色 target）
  if (trimmed.startsWith("grp:")) {
    return trimmed;
  }

  // group:direct:{panelId}:role:{groupRoleId} 作为群组角色 target 透传
  if (/^group:direct:[^:]+:role:.+$/.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("session:")) {
    return normalizeChannelTarget(trimmed.slice("session:".length));
  }

  if (trimmed.startsWith("panel:")) {
    const panelId = trimmed.slice("panel:".length).trim();
    return panelId ? `direct:${panelId}` : null;
  }

  if (trimmed.startsWith("channel:")) {
    const channelId = trimmed.slice("channel:".length).trim();
    return channelId ? `direct:${channelId}` : null;
  }

  if (trimmed.startsWith("direct:")) {
    const next = trimmed.slice("direct:".length).trim();
    return next.includes(":") ? normalizeChannelTarget(next) : (next ? `direct:${next}` : null);
  }

  if (trimmed.startsWith("group:")) {
    const next = trimmed.slice("group:".length).trim();
    return next.includes(":") ? normalizeChannelTarget(next) : (next ? `direct:${next}` : null);
  }

  if (trimmed.startsWith("customchat:")) {
    const next = trimmed.slice("customchat:".length).trim();
    return next.includes(":") ? normalizeChannelTarget(next) : (next ? `direct:${next}` : null);
  }

  if (trimmed.startsWith("agent:")) {
    // Strip agent:<agentId>: and recurse
    const parts = trimmed.split(":");
    if (parts.length >= 3) {
      return normalizeChannelTarget(parts.slice(2).join(":"));
    }
  }

  return null;
}

/**
 * 构建标准会话键，格式：`agent:<agentId>:customchat:group:direct:<id>`。
 * @param agentId - Agent ID
 * @param target - 归一化后的目标（如 `direct:xxx`）
 * @returns 标准会话键
 */
export function buildCanonicalSessionKey(agentId: string, target: string) {
  // grp: 前缀直接拼接（群组角色 session key）
  if (target.startsWith("grp:")) {
    return `agent:${agentId}:customchat:${target}`;
  }

  if (/^group:direct:[^:]+:role:.+$/.test(target)) {
    return `agent:${agentId}:customchat:${target}`;
  }

  const match = /^(direct|channel):(.+)$/.exec(target);
  if (!match?.[2]) {
    return `agent:${agentId}:customchat:${target}`;
  }

  return `agent:${agentId}:customchat:group:direct:${match[2]}`;
}

/**
 * 验证候选会话键是否以 `agent:` 开头。
 * @param value - 候选会话键
 * @returns 有效的会话键，或 null
 */
export function normalizeSessionKeyCandidate(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("agent:") ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Text / target / runId extraction from message payloads
// ---------------------------------------------------------------------------

/**
 * 从消息载荷中提取文本内容。
 * 按优先级尝试：字符串 → text → caption → body → parts 数组。
 * @param input - 消息载荷
 * @returns 提取到的文本，或空字符串
 */
export function extractText(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  if (!input || typeof input !== "object") {
    return "";
  }

  const record = input as JsonRecord;

  if (typeof record.text === "string") {
    return record.text;
  }

  if (typeof record.caption === "string") {
    return record.caption;
  }

  if (typeof record.body === "string") {
    return record.body;
  }

  if (Array.isArray(record.parts)) {
    return record.parts
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const partRecord = part as JsonRecord;
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

/**
 * 从消息载荷中提取并归一化投递目标。
 * 按优先级从 target/to/threadId/thread/sessionKey 及嵌套的 meta/context/deliveryContext 中查找。
 * @param input - 消息载荷
 * @returns 归一化后的目标
 * @throws 找不到有效目标时抛出 Error
 */
export function extractTarget(input: unknown): string {
  if (typeof input === "string") {
    const normalized = normalizeChannelTarget(input);
    if (!normalized) {
      throw new Error("customchat target is required.");
    }
    return normalized;
  }

  if (!input || typeof input !== "object") {
    throw new Error("customchat target is required.");
  }

  const record = input as JsonRecord;
  const meta = asJsonRecord(record.meta);
  const context = asJsonRecord(record.context);
  const deliveryContext = asJsonRecord(record.deliveryContext);

  const normalized = normalizeChannelTarget(
    typeof record.target === "string"
      ? record.target
      : typeof record.to === "string"
        ? record.to
        : typeof record.threadId === "string"
          ? record.threadId
          : typeof record.thread === "string"
            ? record.thread
            : typeof record.sessionKey === "string"
              ? record.sessionKey
              : typeof meta.target === "string"
                ? meta.target
                : typeof meta.to === "string"
                  ? meta.to
                  : typeof meta.sessionKey === "string"
                    ? meta.sessionKey
                    : typeof context.target === "string"
                      ? context.target
                      : typeof context.to === "string"
                        ? context.to
                        : typeof context.sessionKey === "string"
                          ? context.sessionKey
                          : typeof deliveryContext.to === "string"
                            ? deliveryContext.to
                            : typeof deliveryContext.target === "string"
                              ? deliveryContext.target
                              : typeof deliveryContext.sessionKey === "string"
                                ? deliveryContext.sessionKey
                                : undefined,
  );

  if (!normalized) {
    throw new Error("customchat target is required.");
  }

  return normalized;
}

/**
 * 从消息载荷中提取会话键提示（不做归一化，只取原始值）。
 * @param input - 消息载荷
 * @returns 会话键字符串，或 null
 */
export function extractSessionKeyHint(input: unknown): string | null {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed || null;
  }

  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as JsonRecord;
  const meta = asJsonRecord(record.meta);
  const context = asJsonRecord(record.context);
  const deliveryContext = asJsonRecord(record.deliveryContext);

  const candidate =
    typeof record.sessionKey === "string"
      ? record.sessionKey
      : typeof record.target === "string"
        ? record.target
        : typeof record.to === "string"
          ? record.to
          : typeof meta.sessionKey === "string"
            ? meta.sessionKey
            : typeof meta.target === "string"
              ? meta.target
              : typeof meta.to === "string"
                ? meta.to
                : typeof context.sessionKey === "string"
                  ? context.sessionKey
                  : typeof context.target === "string"
                    ? context.target
                    : typeof context.to === "string"
                      ? context.to
                      : typeof deliveryContext.sessionKey === "string"
                        ? deliveryContext.sessionKey
                        : typeof deliveryContext.target === "string"
                          ? deliveryContext.target
                          : typeof deliveryContext.to === "string"
                            ? deliveryContext.to
                            : null;

  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

/**
 * 从消息载荷中提取 runId（支持顶层及 meta/context 嵌套）。
 * @param input - 消息载荷
 * @returns runId 字符串，或 null
 */
export function extractRunId(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const record = input as JsonRecord;
  if (typeof record.runId === "string" && record.runId.trim()) {
    return record.runId.trim();
  }

  const meta = asJsonRecord(record.meta);
  if (typeof meta.runId === "string" && meta.runId.trim()) {
    return meta.runId.trim();
  }

  const context = asJsonRecord(record.context);
  if (typeof context.runId === "string" && context.runId.trim()) {
    return context.runId.trim();
  }

  return null;
}

/**
 * 构建消息 ID：优先使用载荷中的 messageId，否则生成 `customchat:<uuid>`。
 * @param input - 消息载荷
 * @param uuid - 回退用的 UUID
 * @returns 消息 ID
 */
export function buildMessageId(input: unknown, uuid: string): string {
  if (
    input &&
    typeof input === "object" &&
    typeof (input as JsonRecord).messageId === "string" &&
    ((input as JsonRecord).messageId as string).trim()
  ) {
    return ((input as JsonRecord).messageId as string).trim();
  }

  return `customchat:${uuid}`;
}

// ---------------------------------------------------------------------------
// Message payload inspection
// ---------------------------------------------------------------------------

/**
 * 从消息载荷中提取文本（比 extractText 更全面，额外支持 content 数组）。
 * @param input - 消息载荷
 * @returns 提取到的文本，或空字符串
 */
export function extractTextFromMessagePayload(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }

  if (!input || typeof input !== "object") {
    return "";
  }

  const record = input as JsonRecord;
  if (typeof record.text === "string") {
    return record.text.trim();
  }

  if (typeof record.body === "string") {
    return record.body.trim();
  }

  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const contentRecord = item as JsonRecord;
        if (typeof contentRecord.text === "string") {
          return contentRecord.text;
        }
        if (contentRecord.type === "text" && typeof contentRecord.text === "string") {
          return contentRecord.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  if (Array.isArray(record.parts)) {
    return record.parts
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const contentRecord = item as JsonRecord;
        return typeof contentRecord.text === "string" ? contentRecord.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

/**
 * 提取消息角色（role 或 kind 字段）。
 * @param input - 消息记录
 * @returns 角色字符串（如 "user"、"assistant"），或空字符串
 */
export function extractMessageRole(input: unknown) {
  const record = asJsonRecord(input);
  if (typeof record.role === "string" && record.role.trim()) {
    return record.role.trim();
  }
  if (typeof record.kind === "string" && record.kind.trim()) {
    return record.kind.trim();
  }
  return "";
}

/**
 * 判断消息是否为投递镜像消息（provider=openclaw, model=delivery-mirror）。
 * 这类消息是插件自身投递到 Gateway 的回声，应跳过处理。
 * @param input - 消息记录
 * @returns 是否为投递镜像
 */
export function isDeliveryMirrorMessage(input: unknown) {
  const record = asJsonRecord(input);
  const provider =
    typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const api = typeof record.api === "string" ? record.api.trim() : "";
  return (
    provider === "openclaw" &&
    model === "delivery-mirror" &&
    api === "openai-responses"
  );
}

/**
 * 生成工具调用参数的摘要文本，用于 UI 展示。
 * 优先取 command → path/file/query/url/pattern → 工具名。
 * @param toolName - 工具名称
 * @param argumentsRecord - 工具参数记录
 * @returns 摘要文本
 */
export function summarizeToolArguments(toolName: string, argumentsRecord: JsonRecord) {
  const command = extractStringValue(argumentsRecord.command);
  if (command) {
    return command;
  }

  const candidate =
    extractStringValue(argumentsRecord.path) ||
    extractStringValue(argumentsRecord.file) ||
    extractStringValue(argumentsRecord.query) ||
    extractStringValue(argumentsRecord.url) ||
    extractStringValue(argumentsRecord.pattern);
  if (candidate) {
    return candidate;
  }

  return toolName;
}

// ---------------------------------------------------------------------------
// Assistant text extraction from message history
// ---------------------------------------------------------------------------

/**
 * 从消息数组中提取所有助手消息的文本并拼接。
 * 跳过投递镜像消息。
 * @param messages - 消息记录数组
 * @returns 拼接后的助手文本
 */
export function extractLatestAssistantTextFromMessages(messages: unknown[]) {
  const texts: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const messageRecord = candidate as JsonRecord;
    const role =
      typeof messageRecord.role === "string"
        ? messageRecord.role
        : typeof messageRecord.kind === "string"
          ? messageRecord.kind
          : null;

    if (role !== "assistant" || isDeliveryMirrorMessage(messageRecord)) {
      continue;
    }

    const text = extractTextFromMessagePayload(candidate);
    if (text) {
      texts.push(text);
    }
  }

  return texts.filter(Boolean).join("\n\n").trim();
}

/**
 * 提取当前轮次（最后一条用户消息之后）的助手文本。
 * @param messages - 消息记录数组
 * @returns 当前轮次的助手文本
 */
export function extractLatestAssistantTextForCurrentTurn(messages: unknown[]) {
  let latestUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const messageRecord = candidate as JsonRecord;
    if (extractMessageRole(messageRecord) === "user") {
      latestUserIndex = index;
    }
  }

  if (latestUserIndex < 0) {
    return extractLatestAssistantTextFromMessages(messages);
  }

  return extractLatestAssistantTextFromMessages(messages.slice(latestUserIndex + 1));
}

/**
 * 从包含 messages 数组的载荷中提取助手文本。
 * @param payload - 包含 messages 字段的载荷
 * @returns 助手文本
 */
export function extractLatestAssistantText(payload: unknown) {
  const record = asJsonRecord(payload);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  return extractLatestAssistantTextFromMessages(messages);
}

/**
 * 提取当前轮次的消息（最后一条用户消息之后的所有消息）。
 * @param messages - 消息记录数组
 * @returns 当前轮次的消息子数组
 */
export function extractCurrentTurnMessages(messages: unknown[]) {
  let latestUserIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (extractMessageRole(candidate) === "user") {
      latestUserIndex = index;
    }
  }

  if (latestUserIndex < 0) {
    return messages;
  }

  return messages.slice(latestUserIndex + 1);
}

// ---------------------------------------------------------------------------
// Session record helpers
// ---------------------------------------------------------------------------

/**
 * 判断值是否形似会话记录（含 key/sessionKey/id 字段）。
 * @param value - 待判断的值
 * @returns 类型守卫
 */
export function looksLikeSessionRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as JsonRecord;
  return (
    typeof record.key === "string" ||
    typeof record.sessionKey === "string" ||
    (typeof record.id === "string" && String(record.id).includes(":"))
  );
}

/**
 * 递归扁平化嵌套结构中的所有会话记录。
 * @param payload - 可能嵌套的载荷
 * @param depth - 当前递归深度
 * @param seen - 已访问对象集合
 * @returns 扁平化后的会话记录数组
 */
export function flattenSessionRecords(
  payload: unknown,
  depth = 0,
  seen = new Set<unknown>(),
): JsonRecord[] {
  if (depth > 5 || payload == null || seen.has(payload)) {
    return [] as JsonRecord[];
  }

  if (Array.isArray(payload)) {
    seen.add(payload);
    return payload.flatMap((entry) => flattenSessionRecords(entry, depth + 1, seen));
  }

  if (typeof payload !== "object") {
    return [] as JsonRecord[];
  }

  const record = payload as JsonRecord;
  seen.add(record);

  const direct: JsonRecord[] = looksLikeSessionRecord(record) ? [record] : [];
  const nested = Object.values(record).flatMap((entry) =>
    flattenSessionRecords(entry, depth + 1, seen),
  );
  return [...direct, ...nested];
}

/**
 * 将会话记录转换为 SessionSnapshot 快照。
 * @param record - 会话记录
 * @returns SessionSnapshot，无效记录返回 null
 */
export function toSessionSnapshot(record: JsonRecord): SessionSnapshot | null {
  const keyCandidate =
    typeof record.key === "string"
      ? record.key
      : typeof record.sessionKey === "string"
        ? record.sessionKey
        : typeof record.id === "string" && record.id.includes(":")
          ? record.id
          : null;

  if (!keyCandidate?.trim()) {
    return null;
  }

  const updatedAtMs = Math.max(
    parseTimestampMs(record.updatedAt),
    parseTimestampMs(record.lastUpdatedAt),
    parseTimestampMs(record.lastActivityAt),
    parseTimestampMs(record.modifiedAt),
    parseTimestampMs(record.createdAt),
    parseTimestampMs(record.ts),
    parseTimestampMs(record.timestamp),
  );

  return {
    key: keyCandidate.trim(),
    updatedAtMs,
    strings: collectStringValues(record),
    raw: record,
  };
}

/**
 * 为会话快照打分，用于匹配最佳会话。
 * 根据 key 精确匹配、target 匹配、agentId 前缀、时间接近度等维度计分。
 * @param snapshot - 会话快照
 * @param input - 匹配参数（agentId、target、expectedSessionKey、startedAtMs）
 * @returns 匹配分数（越高越匹配）
 */
export function scoreSessionSnapshot(snapshot: SessionSnapshot, input: {
  agentId: string;
  target: string;
  expectedSessionKey: string;
  startedAtMs: number;
}) {
  let score = 0;
  const normalizedStrings = new Set(
    snapshot.strings
      .map((value) => normalizeChannelTarget(value))
      .filter((value): value is string => Boolean(value)),
  );

  if (snapshot.key === input.expectedSessionKey) {
    score += 140;
  }

  if (normalizedStrings.has(input.target)) {
    score += 90;
  }

  if (snapshot.strings.includes(input.target)) {
    score += 50;
  }

  if (snapshot.key.startsWith(`agent:${input.agentId}:`)) {
    score += 35;
  }

  if (snapshot.key.includes(":customchat:")) {
    score += 20;
  }

  if (snapshot.updatedAtMs >= input.startedAtMs - 2000) {
    score += 40;
  } else if (snapshot.updatedAtMs >= input.startedAtMs - 60_000) {
    score += 10;
  }

  return score;
}

/**
 * 判断会话快照是否表明上次运行已被中止。
 * @param snapshot - 会话快照
 * @returns 是否已中止
 */
export function sessionShowsAbortedLastRun(snapshot: SessionSnapshot | null) {
  if (!snapshot) {
    return false;
  }

  return snapshot.raw.abortedLastRun === true;
}

/**
 * 解析 Gateway 等待状态。
 * @param payload - Gateway 响应载荷
 * @returns 状态字符串，默认 "timeout"
 */
export function parseGatewayWaitStatus(payload: unknown) {
  const record = asJsonRecord(payload);
  return typeof record.status === "string" ? record.status.trim() : "timeout";
}

/**
 * 判断 Gateway 等待状态是否为终态。
 * @param status - 状态字符串
 * @returns 是否为终态（ok/completed/done/aborted/cancelled/error）
 */
export function isTerminalGatewayWaitStatus(status: string) {
  return (
    status === "ok" ||
    status === "completed" ||
    status === "done" ||
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "error"
  );
}

// ---------------------------------------------------------------------------
// Agent record helpers
// ---------------------------------------------------------------------------

/**
 * 判断值是否形似 Agent 记录（含 id/agentId/name/label 字段）。
 * @param value - 待判断的值
 * @returns 类型守卫
 */
export function looksLikeAgentRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as JsonRecord;
  return (
    typeof record.id === "string" ||
    typeof record.agentId === "string" ||
    typeof record.name === "string" ||
    typeof record.label === "string"
  );
}

/**
 * 递归扁平化嵌套结构中的所有 Agent 记录。
 * @param payload - 可能嵌套的载荷
 * @param depth - 当前递归深度
 * @param seen - 已访问对象集合
 * @returns 扁平化后的 Agent 记录数组
 */
export function flattenAgentRecords(payload: unknown, depth = 0, seen = new Set<unknown>()): JsonRecord[] {
  if (depth > 5 || payload == null || seen.has(payload)) {
    return [];
  }

  if (Array.isArray(payload)) {
    seen.add(payload);
    return payload.flatMap((entry) => flattenAgentRecords(entry, depth + 1, seen));
  }

  if (typeof payload !== "object") {
    return [];
  }

  const record = payload as JsonRecord;
  seen.add(record);
  const direct = looksLikeAgentRecord(record) ? [record] : [];
  const nested = Object.values(record).flatMap((entry) =>
    flattenAgentRecords(entry, depth + 1, seen),
  );
  return [...direct, ...nested];
}

/**
 * 将 Agent 记录转换为前端可用的视图对象（id, name, emoji, avatarUrl, theme）。
 * @param record - Agent 记录
 * @returns Agent 视图对象，无效记录返回 null
 */
export function toAgentView(record: JsonRecord) {
  const identity = asJsonRecord(record.identity);
  const agentId =
    typeof record.id === "string"
      ? record.id
      : typeof record.agentId === "string"
        ? record.agentId
        : null;

  if (!agentId?.trim()) {
    return null;
  }

  const nameCandidate =
    typeof record.name === "string"
      ? record.name
      : typeof record.label === "string"
        ? record.label
        : typeof record.identityName === "string"
          ? record.identityName
        : typeof identity.name === "string"
          ? identity.name
          : agentId;

  const emojiCandidate =
    typeof record.identityEmoji === "string"
      ? record.identityEmoji
      : typeof identity.emoji === "string"
        ? identity.emoji
        : null;
  const avatarCandidate =
    typeof record.identityAvatarUrl === "string"
      ? record.identityAvatarUrl
      : typeof identity.avatarUrl === "string"
        ? identity.avatarUrl
        : null;
  const themeCandidate =
    typeof record.identityTheme === "string"
      ? record.identityTheme
      : typeof identity.theme === "string"
        ? identity.theme
        : null;

  return {
    id: agentId.trim(),
    name: nameCandidate.trim() || agentId.trim(),
    emoji: emojiCandidate?.trim() || null,
    avatarUrl: avatarCandidate?.trim() || null,
    theme: themeCandidate?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// JSON output parsing
// ---------------------------------------------------------------------------

/**
 * 解析 OpenClaw CLI 的 JSON 输出。
 * 先尝试整体解析，失败则逐行从后向前尝试。
 * @param raw - 原始输出字符串
 * @returns 解析后的 JSON 值
 * @throws 无法解析时抛出 Error
 */
export function parseJsonOutput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index] as string);
      } catch {
        continue;
      }
    }
  }

  throw new Error("Unable to parse OpenClaw JSON output.");
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * 从 HTTP 请求头中读取认证令牌。
 * 支持 `Authorization: Bearer <token>` 和 `X-Customchat-Token` 头。
 * @param req - HTTP 请求对象
 * @returns 令牌字符串，或空字符串
 */
export function readAuthorizationToken(req: { headers: Record<string, string | string[] | undefined> }) {
  const authorization = req.headers.authorization;
  const rawAuth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (rawAuth?.startsWith("Bearer ")) {
    return rawAuth.slice("Bearer ".length).trim();
  }

  const tokenHeader = req.headers["x-customchat-token"];
  const token = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  return token?.trim() || "";
}

// ---------------------------------------------------------------------------
// Inbound message building
// ---------------------------------------------------------------------------

/**
 * 判断是否需要在入站消息中注入路由提示。
 * 当目标未知、有附件、或文本含媒体相关关键词时返回 true。
 * @param input - 包含 targetAlreadyKnown、text、attachmentCount 的参数
 * @returns 是否需要注入路由提示
 */
export function shouldInjectRoutingHint(input: {
  targetAlreadyKnown: boolean;
  text: string;
  attachmentCount: number;
}) {
  if (!input.targetAlreadyKnown) {
    return true;
  }

  if (input.attachmentCount > 0) {
    return true;
  }

  return /附件|图片|图像|image|media|file|文件|avatar|头像/i.test(input.text);
}

/**
 * 构建发送给 Agent 的入站消息文本。
 * 将用户文本、路由提示、附件信息和提取的文本内容组合成一条完整消息。
 * @param target - 投递目标
 * @param text - 用户文本
 * @param files - 已物化的附件文件列表
 * @param manifestPath - manifest.json 路径
 * @param options - 可选配置（includeRoutingHint）
 * @returns 组装后的消息文本
 */
export function buildInboundAgentMessage(
  target: string,
  text: string,
  files: Array<{
    name: string;
    mimeType: string;
    path: string;
    size: number;
    extractedText: string | null;
  }>,
  manifestPath: string | null,
  options?: {
    includeRoutingHint?: boolean;
  },
) {
  const includeRoutingHint = options?.includeRoutingHint ?? false;
  const routingBlock = includeRoutingHint
    ? `\n\n[customchat reply routing]\nCurrent reply channel: customchat\nCurrent reply target: ${target}\nIf you use the OpenClaw message tool with action "send" (including sending images/files/media), you must set channel to exactly customchat and target to exactly ${target}.`
    : "";

  if (files.length === 0) {
    return `${text.trim()}${routingBlock}`.trim();
  }

  const extractedTextBlocks = files
    .filter((file) => file.extractedText)
    .map((file) => `## File: ${file.name}\n${file.extractedText}`);

  const attachmentBlock = `${routingBlock}\n\n[customchat attachments]\n${files
      .map((file) => `- ${file.name} (${file.mimeType}, ${file.size} bytes)`)
      .join("\n")}\n\n[OpenClaw local files]\n${files
      .map((file) => `- ${file.name}: ${file.path}`)
      .join("\n")}${manifestPath ? `\n- manifest.json: ${manifestPath}` : ""
    }\nUse these exact filesystem paths when you need to read, unzip, or process the uploaded files.${extractedTextBlocks.length > 0
      ? `\n\n[Extracted text]\n${extractedTextBlocks.join("\n\n")}`
      : ""
    }`;

  return `${text.trim()}${attachmentBlock}`.trim();
}

// ---------------------------------------------------------------------------
// Base64 URL encoding
// ---------------------------------------------------------------------------

/**
 * 将 Buffer 编码为 Base64 URL 安全格式（无填充）。
 * @param input - 待编码的 Buffer
 * @returns Base64 URL 编码字符串
 */
export function base64UrlEncode(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * 构建 v3 版设备认证签名载荷字符串（各字段以 `|` 分隔）。
 * @param input - 认证参数（deviceId、clientId、role、scopes 等）
 * @returns 待签名的载荷字符串
 */
export function buildDeviceAuthPayloadV3(input: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAt: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}) {
  return [
    "v3",
    input.deviceId,
    input.clientId,
    input.clientMode,
    input.role,
    [...new Set(input.scopes.map((scope) => scope.trim()).filter(Boolean))].sort().join(","),
    String(input.signedAt),
    input.token,
    input.nonce,
    input.platform.trim(),
    input.deviceFamily?.trim() || "",
  ].join("|");
}
