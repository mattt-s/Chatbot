/**
 * customchat 频道运行时核心模块。
 *
 * 本模块实现了 OpenClaw Gateway 与 Next.js 前端应用之间的消息桥接：
 * - 接收前端 HTTP 入站请求，转发给 Gateway（chat.send RPC）
 * - 通过 WebSocket 订阅 Gateway 事件流（event:chat / event:agent）
 * - 将 Gateway 的流式响应（delta/final/aborted/error）通过 WebSocket 投递给前端
 * - 管理 TrackedRun 状态机，跟踪每个 Agent 运行的生命周期
 * - 处理路由绑定持久化、会话管理、附件物化等
 *
 * 核心数据流：
 *   前端 → HTTP POST /customchat/inbound → 本插件 → Gateway chat.send RPC
 *   Gateway → WebSocket 事件流 → 本插件 → WebSocket 投递 → 前端 SSE
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import {
  type JsonRecord,
  type AttachmentPayload,
  type PortalDeliveryState,
  asJsonRecord,
  sleep,
  parseTimestampMs,
  extractStringValue,
  sanitizeFilename,
  normalizePathSegment,
  fileNameFromPath,
  filenameFromUrl,
  inferMimeType,
  inferMimeTypeFromUrl,
  guessImageMimeType,
  toLocalFilePath,
  isHttpUrl,
  isDataUrl,
  extractMediaRefsFromText,
  stripMediaRefsFromText,
  isTextLikeFile,
  flattenMediaInputs,
  normalizeChannelTarget,
  buildCanonicalSessionKey,
  normalizeSessionKeyCandidate,
  extractText,
  extractTarget,
  extractSessionKeyHint,
  extractRunId,
  extractTextFromMessagePayload,
  isDeliveryMirrorMessage,
  extractCurrentTurnMessages,
  sessionShowsAbortedLastRun,
  parseGatewayWaitStatus,
  isTerminalGatewayWaitStatus,
  toAgentView,
  readAuthorizationToken,
  buildInboundAgentMessage,
  base64UrlEncode,
} from "./utils.js";
import type { CustomChatHttpRouteApi, CustomChatLegacyActivateApi } from "./api-types.js";
import {
  CUSTOMCHAT_CHANNEL_META,
  CUSTOMCHAT_PLUGIN_ID,
} from "./meta.js";
import {
  buildCustomChatRuntimeInspection,
  customChatRuntimeStore,
  findTrackedRunCandidate,
  getCustomChatRuntimeStatusSummary,
  hasRuntimeTerminalState,
  markCustomChatServiceBoot,
  markGatewaySubscriberLoopStarted,
  recordGatewaySubscriberConnected,
  recordGatewaySubscriberError,
} from "./runtime-store.js";
import type {
  CustomChatAbortResult,
  CustomChatControlParams,
  CustomChatSessionInspection,
  CustomChatSessionStatus,
  TrackedRun,
} from "./runtime-types.js";
import { ensureCustomChatRecoveryLoop } from "./subscriber-service.js";
import {
  abortGatewayManagedSession,
  abortGatewaySession,
  deleteGatewaySession,
  fetchGatewayChatHistory,
  listGatewaySessions,
  readGatewaySessionRecord,
  resolveActualSessionKey,
  sendGatewayChatTurn,
  waitForGatewayRun,
} from "./gateway-transport.js";
import {
  findRouteBinding,
  readRouteState,
  rememberRouteBinding,
  removeRouteBinding,
} from "./route-state-store.js";
import { CUSTOMCHAT_STORAGE_ROOT } from "./storage.js";

// ---------------------------------------------------------------------------
// Plugin Debug Logging
// Control: channels.customchat.debug in ~/.openclaw/openclaw.json
//   or env CUSTOMCHAT_DEBUG=true
// ---------------------------------------------------------------------------

let _pluginDebugResolved = false;
let _pluginDebugEnabled = false;

/**
 * 解析插件调试日志开关。从 ~/.openclaw/openclaw.json 配置中读取 channels.customchat.debug。
 * @returns 是否启用调试日志
 */
async function resolvePluginDebug(): Promise<boolean> {
  if (_pluginDebugResolved) return _pluginDebugEnabled;
  _pluginDebugResolved = true;

  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as JsonRecord;
    const channels = raw.channels as JsonRecord | undefined;
    const customchat = channels?.customchat as JsonRecord | undefined;
    if (customchat?.debug === true) {
      _pluginDebugEnabled = true;
      return true;
    }
  } catch {
    // Config unreadable — default off
  }

  _pluginDebugEnabled = false;
  return false;
}

/**
 * 插件调试日志输出（仅在调试模式下输出）。
 * @param tag - 日志标签
 * @param fn - 函数名
 * @param label - 描述标签
 * @param data - 可选的附加数据
 */
function pluginLog(tag: string, fn: string, label: string, data?: Record<string, unknown>) {
  if (!_pluginDebugEnabled) return;
  const ts = new Date().toISOString();
  const body = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`${ts} [DEBUG] [customchat:${tag}] ${fn} ${label}${body}`);
}

type InboundAttachmentPayload = {
  name: string;
  mimeType: string;
  content: string;
  size?: number;
};

type AccountConfig = {
  accountId: string;
  authToken: string;
  bridgePort: number;
};

type ChannelContext = {
  channelConfig?: unknown;
  config?: {
    channels?: {
      customchat?: unknown;
    };
  };
  accountId?: string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
};

type InboundRequestPayload = {
  panelId?: string;
  agentId?: string;
  target?: string;
  messageId?: string;
  text?: string;
  attachments?: InboundAttachmentPayload[];
};

type SessionMutationPayload = {
  panelId?: string;
  agentId?: string;
  target?: string;
  sessionKey?: string;
  runId?: string;
  deleteTranscript?: boolean;
};

type LaunchChatTurnInput = {
  agentId: string;
  target: string;
  message: string;
  messageId: string;
};

type PortalDeliveryPayload = {
  target: string;
  sessionKey: string;
  runId: string;
  seq: number;
  messageId: string;
  text: string;
  state: PortalDeliveryState;
  attachments: AttachmentPayload[];
  runtimeSteps?: Array<{
    id: string;
    stream: string;
    ts: number;
    data: JsonRecord;
  }>;
  errorMessage?: string;
  usage?: unknown;
  stopReason?: string;
};

type PortalQueueItem = {
  requestId: string;
  payload: PortalDeliveryPayload;
  accountConfig: AccountConfig;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeoutAtMs: number;
};

type GatewayDeviceIdentity = {
  deviceId: string;
  publicKey: string;
  publicKeyPem: string;
  privateKeyPem: string;
  platform: string;
  deviceFamily?: string;
  deviceToken?: string;
};

const DEFAULT_INGRESS_PATH = "/customchat/inbound";
const DEFAULT_AGENTS_PATH = "/customchat/agents";
const DEFAULT_AGENT_AVATAR_PATH = "/customchat/agent-avatar";
const DEFAULT_SESSION_PATH = "/customchat/session";
const DEFAULT_STATUS_PATH = "/customchat/status";
const DEFAULT_ABORT_PATH = "/customchat/abort";
const DEFAULT_APP_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_APP_BRIDGE_PORT = "3001";
const DEFAULT_APP_BRIDGE_PATH = "/api/customchat/socket";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ACTIVE_RUN_RECOVERY_INTERVAL_MS = 60_000;
const ACTIVE_RUN_RECOVERY_THROTTLE_MS = 2_500;
const ACTIVE_RUN_STALE_TTL_MS = 30 * 60 * 1000;
const PORTAL_SEND_TIMEOUT_MS = 20_000;
const PORTAL_BRIDGE_RECONNECT_INTERVAL_MS = 1_000;
const PORTAL_RECONNECT_BACKOFF_MS = [250, 500, 1_000, 2_000, 4_000];
const RESTORED_TRACKED_RUN_LIMIT = 16;
const GATEWAY_SUBSCRIBER_CONNECT_TIMEOUT_MS = 5_000;
const GATEWAY_SUBSCRIBER_START_DELAY_MS = 1_500;
const RECENT_ANNOUNCE_TTL_MS = 15_000;

let cachedGatewayDeviceIdentity: GatewayDeviceIdentity | null | undefined;
const { trackedRuns } = customChatRuntimeStore;
const recentAnnounceDeliveries = new Map<
  string,
  { atMs: number; runId: string; text: string }
>();

function resolveTargetFromControlParams(input: CustomChatControlParams) {
  return normalizeChannelTarget(input.target || `channel:${input.panelId || ""}`);
}

export function getCustomChatRuntimeStatus() {
  return getCustomChatRuntimeStatusSummary();
}

function readNumericSessionField(record: JsonRecord, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compactTokenCount(value: number) {
  if (value < 1000) {
    return String(value);
  }

  const kilo = value / 1000;
  if (kilo >= 100 || Number.isInteger(kilo)) {
    return `${Math.round(kilo)}k`;
  }

  return `${kilo.toFixed(1).replace(/\.0$/, "")}k`;
}

function buildSessionStatusText(record: JsonRecord) {
  const model = extractStringValue(record.model);
  const modelProvider = extractStringValue(record.modelProvider);
  const totalTokens = readNumericSessionField(record, "totalTokens");
  const contextTokens = readNumericSessionField(record, "contextTokens");
  const compactions =
    readNumericSessionField(record, "compactionCount") ??
    readNumericSessionField(record, "authProfileOverrideCompactionCount") ??
    0;

  const modelLabel =
    model && modelProvider
      ? `${modelProvider}/${model}`
      : model ?? modelProvider ?? null;

  const lines: string[] = [];

  if (modelLabel) {
    lines.push(`🧠 Model: ${modelLabel}`);
  }

  if (totalTokens != null && contextTokens != null && contextTokens > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((totalTokens / contextTokens) * 100)));
    lines.push(
      `📚 Context: ${compactTokenCount(totalTokens)}/${compactTokenCount(contextTokens)} (${percent}%) · 🧹 Compactions: ${compactions}`,
    );
  } else {
    lines.push(`📚 Context: unavailable · 🧹 Compactions: ${compactions}`);
  }

  return lines.join("\n");
}

export async function readCustomChatSessionStatus(
  input: CustomChatControlParams,
): Promise<CustomChatSessionStatus> {
  const target = resolveTargetFromControlParams(input);
  const sessionKeyHint = input.sessionKey?.trim() || null;

  if (!target && !sessionKeyHint) {
    throw new Error("target or sessionKey is required.");
  }

  const remembered = await findRouteBinding({
    target: target || undefined,
    sessionKey: sessionKeyHint,
  });
  const agentId = input.agentId?.trim() || remembered?.agentId || "main";
  const sessionKey =
    normalizeSessionKeyCandidate(sessionKeyHint) ||
    normalizeSessionKeyCandidate(remembered?.sessionKey) ||
    normalizeSessionKeyCandidate(remembered?.expectedSessionKey) ||
    (target ? buildCanonicalSessionKey(agentId, target) : null);

  const rawRecord = sessionKey ? await readGatewaySessionRecord(sessionKey) : null;
  if (rawRecord) {
    return {
      target,
      sessionKey,
      exists: true,
      statusText: buildSessionStatusText(rawRecord),
      source: "session-store",
    };
  }

  const snapshots = await listGatewaySessions().catch(() => []);
  const snapshot = sessionKey
    ? snapshots.find((candidate) => candidate.key === sessionKey) ?? null
    : null;

  return {
    target,
    sessionKey,
    exists: Boolean(snapshot),
    statusText: snapshot ? buildSessionStatusText(snapshot.raw) : null,
    source: "gateway-fallback",
  };
}

export async function inspectCustomChatSession(
  input: CustomChatControlParams,
): Promise<CustomChatSessionInspection> {
  const target = resolveTargetFromControlParams(input);
  const sessionKeyHint = input.sessionKey?.trim() || null;
  const runId = input.runId?.trim() || null;

  if (!target && !sessionKeyHint) {
    throw new Error("target or sessionKey is required.");
  }

  const remembered = await findRouteBinding({
    target: target || undefined,
    sessionKey: sessionKeyHint,
  });
  const agentId = input.agentId?.trim() || remembered?.agentId || "main";
  const sessionKey =
    normalizeSessionKeyCandidate(sessionKeyHint) ||
    normalizeSessionKeyCandidate(remembered?.sessionKey) ||
    normalizeSessionKeyCandidate(remembered?.expectedSessionKey) ||
    (target ? buildCanonicalSessionKey(agentId, target) : null);

  const trackedRun = findTrackedRunCandidate({
    runId,
    target,
    sessionKey,
  });
  const runtimeInspection = buildCustomChatRuntimeInspection(trackedRun);
  const snapshots = await listGatewaySessions().catch(() => []);
  const snapshot = sessionKey
    ? snapshots.find((candidate) => candidate.key === sessionKey) ?? null
    : null;
  const waitPayload = runId
    ? await waitForGatewayRun(runId, 0).catch(() => null)
    : null;
  const waitStatus = parseGatewayWaitStatus(waitPayload);
  const terminal =
    (trackedRun ? hasRuntimeTerminalState(trackedRun) : false) ||
    sessionShowsAbortedLastRun(snapshot) ||
    (waitStatus ? isTerminalGatewayWaitStatus(waitStatus) : false);

  return {
    target,
    sessionKey,
    exists: Boolean(snapshot) || Boolean(trackedRun),
    terminal,
    waitStatus,
    snapshot,
    runtime: runtimeInspection,
    source: trackedRun ? "runtime" : "gateway-fallback",
  };
}

export async function abortCustomChatSession(
  input: CustomChatControlParams,
): Promise<CustomChatAbortResult> {
  const target = resolveTargetFromControlParams(input);
  if (!target) {
    throw new Error("target is required.");
  }

  const remembered = await findRouteBinding({
    target,
    sessionKey: input.sessionKey?.trim() || null,
  });
  const runtimeTracked = findTrackedRunCandidate({
    runId: input.runId?.trim() || null,
    target,
    sessionKey: input.sessionKey?.trim() || null,
  });
  const agentId = input.agentId?.trim() || remembered?.agentId || "main";
  const sessionKey =
    normalizeSessionKeyCandidate(input.sessionKey) ||
    normalizeSessionKeyCandidate(runtimeTracked?.sessionKey) ||
    normalizeSessionKeyCandidate(remembered?.sessionKey) ||
    normalizeSessionKeyCandidate(remembered?.expectedSessionKey) ||
    buildCanonicalSessionKey(agentId, target);
  const runId =
    input.runId?.trim() ||
    runtimeTracked?.runId ||
    remembered?.runIds.at(-1) ||
    null;

  const chatAbortPayload = asJsonRecord(
    await abortGatewaySession(sessionKey, runId).catch(() => null),
  );
  const chatAbortConfirmed =
    chatAbortPayload.ok !== false &&
    (chatAbortPayload.aborted === true ||
      (Array.isArray(chatAbortPayload.runIds) && chatAbortPayload.runIds.length > 0));

  let noActiveRun = false;
  let sessionAbortConfirmed = false;
  if (!chatAbortConfirmed) {
    // OpenClaw 偶尔会出现旧 runId 仍然 wait timeout / session index 仍显示 running，
    // 但官方 sessions.abort 已经判断该 session 没有 active run 的状态。
    // 这种情况下我们把它视为“当前没有活跃执行”，让上层释放本地 busy 状态，
    // 避免角色永久卡在 aborting。
    const sessionAbortPayload = asJsonRecord(
      await abortGatewayManagedSession(sessionKey).catch(() => null),
    );
    const sessionAbortStatus =
      typeof sessionAbortPayload.status === "string"
        ? sessionAbortPayload.status.trim().toLowerCase()
        : "";
    noActiveRun = sessionAbortStatus === "no-active-run";
    sessionAbortConfirmed =
      typeof sessionAbortPayload.abortedRunId === "string" &&
      sessionAbortPayload.abortedRunId.trim().length > 0;
  }

  const verified = chatAbortConfirmed || sessionAbortConfirmed || noActiveRun;

  return {
    ok: true,
    target,
    sessionKey,
    runId,
    queued: !verified,
    runtimeTracked: Boolean(runtimeTracked),
    verified,
    noActiveRun,
  };
}
let gatewayRecoveryInFlight = false;
let portalSocket: WebSocket | null = null;
let portalSocketUrl: string | null = null;
let portalSocketOpenPromise: Promise<void> | null = null;
let portalPumpActive = false;
const portalQueue: PortalQueueItem[] = [];
let portalPingTimer: ReturnType<typeof globalThis.setInterval> | null = null;
let portalReconnectAttempts = 0;
let portalBridgeLoopStarted = false;

function isPortalSocketConnected() {
  return Boolean(
    portalSocket &&
      portalSocket.readyState === portalSocket.OPEN,
  );
}

/**
 * 从原始配置中解析并验证账户配置（authToken + 可选 bridgePort）。
 * 支持多账户配置（accounts 嵌套），配置唯一真源是 openclaw.json。
 * @param rawConfig - 原始频道配置
 * @param accountId - 账户 ID
 * @returns 解析后的 AccountConfig
 * @throws 缺少 authToken 时抛出 Error
 */
function normalizeAccountConfig(rawConfig: unknown, accountId: string): AccountConfig {
  const directConfig = asJsonRecord(rawConfig);
  const accounts =
    directConfig.accounts &&
      typeof directConfig.accounts === "object" &&
      !Array.isArray(directConfig.accounts)
      ? (directConfig.accounts as Record<string, JsonRecord>)
      : {};
  const resolved =
    accountId && accounts[accountId] && typeof accounts[accountId] === "object"
      ? accounts[accountId]
      : directConfig;

  const authToken =
    typeof resolved.authToken === "string" && resolved.authToken.trim()
      ? resolved.authToken.trim()
      : null;
  const parsedBridgePort =
    typeof resolved.bridgePort === "number" && Number.isFinite(resolved.bridgePort)
      ? Math.trunc(resolved.bridgePort)
      : typeof resolved.bridgePort === "string" && resolved.bridgePort.trim()
        ? Number.parseInt(resolved.bridgePort.trim(), 10)
        : Number.parseInt(DEFAULT_APP_BRIDGE_PORT, 10);
  const bridgePort =
    Number.isFinite(parsedBridgePort) && parsedBridgePort > 0
      ? parsedBridgePort
      : Number.parseInt(DEFAULT_APP_BRIDGE_PORT, 10);

  if (!authToken) {
    throw new Error(
      "customchat requires channels.customchat.authToken",
    );
  }

  return {
    accountId,
    authToken,
    bridgePort,
  };
}

/**
 * 从本地文件路径读取附件。
 * @param value - 文件路径
 * @returns 附件载荷（含 name、mimeType、base64）
 */
async function readAttachmentFromPath(value: string): Promise<AttachmentPayload> {
  const buffer = await fs.readFile(value);
  return {
    name: fileNameFromPath(value),
    mimeType: inferMimeType(value),
    base64: buffer.toString("base64"),
  };
}

/**
 * 从 HTTP/HTTPS URL 下载附件。
 * @param value - 附件 URL
 * @param nameHint - 可选的文件名提示
 * @param mimeTypeHint - 可选的 MIME 类型提示
 * @returns 附件载荷
 */
async function readAttachmentFromUrl(
  value: string,
  nameHint?: string,
  mimeTypeHint?: string,
): Promise<AttachmentPayload> {
  const response = await fetch(value);
  if (!response.ok) {
    throw new Error(
      `Unable to download media ${value} (${response.status} ${response.statusText})`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const mimeType =
    mimeTypeHint?.trim() ||
    response.headers.get("content-type")?.split(";")[0]?.trim() ||
    inferMimeTypeFromUrl(value);

  return {
    name: nameHint?.trim() || filenameFromUrl(value),
    mimeType: mimeType || "application/octet-stream",
    base64: bytes.toString("base64"),
  };
}

/**
 * 从 data: URL 解析附件。
 * @param value - data URL 字符串
 * @param nameHint - 可选的文件名提示
 * @param mimeTypeHint - 可选的 MIME 类型提示
 * @returns 附件载荷
 */
async function readAttachmentFromDataUrl(
  value: string,
  nameHint?: string,
  mimeTypeHint?: string,
): Promise<AttachmentPayload> {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(value.trim());
  if (!match) {
    throw new Error("Unsupported data URL media payload.");
  }

  const mimeType = mimeTypeHint?.trim() || match[1]?.trim() || "application/octet-stream";
  return {
    name: nameHint?.trim() || "attachment",
    mimeType,
    base64: match[2].trim(),
  };
}

/**
 * 根据引用类型自动选择读取方式（data URL / HTTP URL / 本地路径）。
 * @param value - 附件引用字符串
 * @param nameHint - 可选的文件名提示
 * @param mimeTypeHint - 可选的 MIME 类型提示
 * @returns 附件载荷
 */
async function readAttachmentFromRef(
  value: string,
  nameHint?: string,
  mimeTypeHint?: string,
): Promise<AttachmentPayload> {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Attachment reference is empty.");
  }

  if (isDataUrl(trimmed)) {
    return readAttachmentFromDataUrl(trimmed, nameHint, mimeTypeHint);
  }

  if (isHttpUrl(trimmed)) {
    return readAttachmentFromUrl(trimmed, nameHint, mimeTypeHint);
  }

  const localPath = toLocalFilePath(trimmed) || trimmed;
  const attachment = await readAttachmentFromPath(localPath);
  return {
    name: nameHint?.trim() || attachment.name,
    mimeType: mimeTypeHint?.trim() || attachment.mimeType,
    base64: attachment.base64,
  };
}

/**
 * 将各种格式的媒体条目归一化为标准附件载荷。
 * 支持字符串引用、含 path/url/base64 的对象等。
 * @param entry - 媒体条目
 * @returns 附件载荷，无法处理时返回 null
 */
async function normalizeMediaEntry(entry: unknown): Promise<AttachmentPayload | null> {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    return readAttachmentFromRef(entry);
  }

  if (typeof entry === "object") {
    const record = entry as JsonRecord;
    const source =
      (typeof record.path === "string" && record.path.trim()) ||
      (typeof record.filePath === "string" && record.filePath.trim()) ||
      (typeof record.mediaUrl === "string" && record.mediaUrl.trim()) ||
      (typeof record.url === "string" && record.url.trim()) ||
      null;

    if (source) {
      return readAttachmentFromRef(
        source,
        typeof record.name === "string" ? record.name : undefined,
        typeof record.mimeType === "string" ? record.mimeType : undefined,
      );
    }

    if (
      ((typeof record.base64 === "string" && record.base64.trim()) ||
        (typeof record.content === "string" && record.content.trim())) &&
      typeof record.name === "string" &&
      record.name.trim()
    ) {
      return {
        name: record.name.trim(),
        mimeType:
          typeof record.mimeType === "string" && record.mimeType.trim()
            ? record.mimeType.trim()
            : "application/octet-stream",
        base64:
          typeof record.base64 === "string" && record.base64.trim()
            ? record.base64.trim()
            : String(record.content).trim(),
      };
    }
  }

  return null;
}

/**
 * 将嵌套的媒体输入转换为去重的附件列表。
 * @param input - 可能嵌套的媒体输入
 * @returns 去重后的附件载荷数组
 */
async function toAttachmentList(input: unknown): Promise<AttachmentPayload[]> {
  const list = flattenMediaInputs(input);
  const attachments: AttachmentPayload[] = [];
  const seen = new Set<string>();

  for (const item of list) {
    const normalized = await normalizeMediaEntry(item);
    if (normalized) {
      const signature = `${normalized.name}:${normalized.mimeType}:${normalized.base64.length}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      attachments.push(normalized);
    }
  }

  return attachments;
}

/**
 * 从入站请求载荷中提取或生成消息 ID。
 * 优先使用载荷中的 messageId 字段，否则生成 `customchat:{uuid}` 格式的 ID。
 * @param {unknown} input - 入站请求载荷
 * @returns {string} 消息 ID
 */
function buildMessageId(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    typeof (input as JsonRecord).messageId === "string" &&
    ((input as JsonRecord).messageId as string).trim()
  ) {
    return ((input as JsonRecord).messageId as string).trim();
  }

  return `customchat:${crypto.randomUUID()}`;
}

/**
 * 从 openclaw.json 配置读取并构建 Agent 列表。
 * 尝试从 workspace 的 IDENTITY.md 解析名称和 emoji。
 * @returns Agent 视图对象数组
 */
async function listAgents() {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  const agents: Array<NonNullable<ReturnType<typeof toAgentView>>> = [];
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const list = config?.agents?.list || [];
    const defaults = config?.agents?.defaults || {};
    const seen = new Set<string>();

    for (const record of list) {
      const agent = toAgentView(record);
      if (!agent || seen.has(agent.id)) {
        continue;
      }
      seen.add(agent.id);
      
      const workspace = record.workspace || defaults.workspace;
      const agentDir = record.agentDir || path.join(os.homedir(), ".openclaw", "agents", agent.id, "agent");
      
      // IDENTITY.md RESOLUTION:
      // Always try to resolve from IDENTITY.md in workspace if it exists.
      // This prioritizes the identity defined in the project over the global config.
      if (workspace) {
        try {
          const identityPath = path.join(workspace, "IDENTITY.md");
          const content = await fs.readFile(identityPath, "utf8");
          const nameMatch = content.match(/-\s+\*\*Name:\*\*\s+(.*)/i);
          const emojiMatch = content.match(/-\s+\*\*Emoji:\*\*\s+(.*)/i);

          if (nameMatch) {
            agent.name = nameMatch[1].trim();
          }
          if (emojiMatch) {
            agent.emoji = emojiMatch[1].trim();
          }
        } catch {
          // ignore resolution errors
        }
      }

      if (workspace || agentDir) {
        agent.avatarUrl = `${DEFAULT_AGENT_AVATAR_PATH}?agentId=${encodeURIComponent(agent.id)}`;
      }
      agents.push(agent);
    }
  } catch (err) {
    console.error(`[customchat] failed to read agents from config: ${err}`);
  }

  return agents;
}

/**
 * 递归扫描目录下的图片文件（最多 2 层深度）。
 * 支持 png/jpg/jpeg/webp/gif/svg 格式。
 * @param {string} rootDir - 扫描起始目录
 * @returns {Promise<string[]>} 图片文件绝对路径列表
 */
async function listImageFiles(rootDir: string) {
  const stack = [{ dir: rootDir, depth: 0 }];
  const results: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = await fs.readdir(current.dir, {
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 1) {
          stack.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || !/\.(png|jpe?g|webp|gif|svg)$/i.test(entry.name)) {
        continue;
      }

      results.push(fullPath);
    }
  }

  return results;
}

/**
 * 查找 Agent 头像文件路径。按优先级搜索：
 * 1. record.avatar 指定的路径
 * 2. workspace 目录下的图片（AVATAR.*, LOGO.*, avatar.* 等）
 * 3. agentDir 下的图片
 * @param {JsonRecord} record - Agent 配置记录
 * @param {string} agentId - Agent ID
 * @returns {Promise<string | null>} 头像文件路径，未找到返回 null
 */
async function findAgentAvatarPath(record: JsonRecord, agentId: string) {
  const workspace =
    typeof record.workspace === "string" && record.workspace.trim()
      ? record.workspace.trim()
      : null;
  if (!workspace) {
    return null;
  }

  const searchRoots = [workspace, path.join(workspace, "avatars")];
  const candidates: Array<{ filePath: string; score: number; mtimeMs: number }> = [];

  for (const root of searchRoots) {
    const files = await listImageFiles(root).catch(() => []);
    for (const filePath of files) {
      const lower = filePath.toLowerCase();
      let score = 0;
      if (lower.includes("avatar")) {
        score += 6;
      }
      if (lower.includes(agentId.toLowerCase())) {
        score += 4;
      }
      if (lower.includes("/avatars/")) {
        score += 2;
      }

      const stat = await fs.stat(filePath).catch(() => null);
      candidates.push({
        filePath,
        score,
        mtimeMs: stat?.mtimeMs ?? 0,
      });
    }
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.mtimeMs - left.mtimeMs;
  });

  return candidates[0]?.filePath ?? null;
}

/**
 * 读取统一认证令牌。
 * 只使用 ~/.openclaw/openclaw.json 中的 channels.customchat.authToken。
 */
async function getInboundToken() {
  if (cachedInboundToken !== null) {
    return cachedInboundToken;
  }

  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8")) as JsonRecord;
    const channels = asJsonRecord(raw.channels);
    const customchat = asJsonRecord(channels.customchat);
    const authToken = extractStringValue(customchat.authToken);
    if (authToken) {
      cachedInboundToken = authToken;
      return authToken;
    }
  } catch {
    // Ignore config read failures and report missing token below.
  }

  cachedInboundToken = "";
  return cachedInboundToken;
}

/**
 * 向 HTTP 响应写入 JSON 数据。
 * @param {ServerResponse} res - HTTP 响应对象
 * @param {number} statusCode - HTTP 状态码
 * @param {Record<string, unknown>} payload - 响应体数据
 */
function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

/**
 * 从 HTTP 请求体中读取并解析 JSON。限制最大 25MB 防止内存溢出。
 * @param {IncomingMessage} req - HTTP 请求对象
 * @param {number} [maxBytes=25MB] - 最大允许字节数
 * @returns {Promise<unknown>} 解析后的 JSON 数据
 * @throws {Error} 载荷超出大小限制或 JSON 解析失败
 */
async function readJsonRequest(req: IncomingMessage, maxBytes = 25 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error("Payload too large.");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

let cachedDefaultAccountConfig: AccountConfig | null = null;
let cachedInboundToken: string | null = null;
let cachedGatewayAuthToken: string | null = null;
let cachedGatewayPort: number | null = null;

/**
 * 解析默认账户配置，带模块级缓存。
 * 唯一真源是 ~/.openclaw/openclaw.json 中的 channels.customchat 配置。
 * @returns 默认账户配置
 * @throws 无法获取 authToken 时抛出 Error
 */
async function resolveDefaultAccountConfig(): Promise<AccountConfig> {
  if (cachedDefaultAccountConfig) {
    return cachedDefaultAccountConfig;
  }
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    const channelConfig = asJsonRecord(asJsonRecord(raw).channels)?.customchat;
    const result = normalizeAccountConfig(channelConfig ?? {}, "default");
    cachedDefaultAccountConfig = result;
    return result;
  } catch {
    // Config file unreadable — fall through to let normalizeAccountConfig throw with a clear message
  }
  return normalizeAccountConfig({}, "default");
}

/**
 * 解析 Gateway 连接需要的共享 token（gateway.auth.mode=token 时）。
 * 这个 token 和 device token 是两回事：前者是网关的“门票”，后者是设备身份令牌。
 * 插件订阅连接需要同时携带两者（如果网关开启了 token auth）。
 */
async function resolveGatewayAuthToken(): Promise<string> {
  if (cachedGatewayAuthToken !== null) {
    return cachedGatewayAuthToken;
  }
  try {
    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    const token =
      typeof raw?.gateway?.auth?.token === "string" ? raw.gateway.auth.token.trim() : "";
    const resolvedToken = token || "";
    cachedGatewayAuthToken = resolvedToken;
    return resolvedToken;
  } catch {
    cachedGatewayAuthToken = "";
    return "";
  }
}


/**
 * 解析 Gateway WebSocket URL（插件订阅 Gateway 事件流用）。
 * 从 ~/.openclaw/openclaw.json 读取 gateway.port，默认 18789。
 * @returns {Promise<string>} Gateway WebSocket URL
 */
async function resolveGatewayWsUrl(): Promise<string> {
  if (cachedGatewayPort === null) {
    try {
      const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
      const port = typeof raw?.gateway?.port === "number" ? raw.gateway.port : 18789;
      cachedGatewayPort = port;
    } catch {
      cachedGatewayPort = 18789;
    }
  }
  return `ws://127.0.0.1:${cachedGatewayPort}`;
}

/**
 * 构建前端 App WebSocket 连接 URL（插件 → App 的投递通道）。
 * @param accountConfig - 账户配置
 * @returns WebSocket URL 字符串
 */
function resolvePortalWsUrl(accountConfig: AccountConfig) {
  const wsUrl = new URL(`ws://${DEFAULT_APP_BRIDGE_HOST}:${accountConfig.bridgePort}${DEFAULT_APP_BRIDGE_PATH}`);
  wsUrl.searchParams.set("token", accountConfig.authToken);
  return wsUrl.toString();
}

/**
 * 从 PEM 格式公钥中提取 Ed25519 原始字节并编码为 Base64URL。
 * 用于 Gateway WebSocket 设备认证。
 * @param {string} publicKeyPem - PEM 格式的公钥
 * @returns {string} Base64URL 编码的原始公钥
 */
function publicKeyRawBase64UrlFromPem(publicKeyPem: string) {
  const exported = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: "spki", format: "der" });
  const raw = Buffer.from(exported).subarray(ED25519_SPKI_PREFIX.length);
  return base64UrlEncode(raw);
}

/**
 * 加载 Gateway 设备身份信息（用于 WebSocket 认证）。
 * 从 ~/.openclaw/identity/ 读取设备密钥和认证令牌，结果带缓存。
 * @returns 设备身份信息，加载失败返回 null
 */
async function loadGatewayDeviceIdentity(): Promise<GatewayDeviceIdentity | null> {
  if (cachedGatewayDeviceIdentity !== undefined) {
    return cachedGatewayDeviceIdentity;
  }

  try {
    const identityPath = path.join(os.homedir(), ".openclaw", "identity", "device.json");
    const authPath = path.join(os.homedir(), ".openclaw", "identity", "device-auth.json");
    const [identityRaw, authRaw] = await Promise.all([
      fs.readFile(identityPath, "utf8"),
      fs.readFile(authPath, "utf8").catch(() => ""),
    ]);
    const identity = JSON.parse(identityRaw) as JsonRecord;
    const auth = authRaw ? (JSON.parse(authRaw) as JsonRecord) : {};
    const tokens = asJsonRecord(auth.tokens);
    const operatorToken = asJsonRecord(tokens.operator);

    const deviceId =
      typeof identity.deviceId === "string" ? identity.deviceId.trim() : "";
    const publicKeyPem =
      typeof identity.publicKeyPem === "string" ? identity.publicKeyPem.trim() : "";
    const privateKeyPem =
      typeof identity.privateKeyPem === "string" ? identity.privateKeyPem.trim() : "";
    if (!deviceId || !publicKeyPem || !privateKeyPem) {
      cachedGatewayDeviceIdentity = null;
      return null;
    }

    cachedGatewayDeviceIdentity = {
      deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
      platform:
        (typeof identity.platform === "string" && identity.platform.trim()) ||
        process.platform ||
        "linux",
      deviceFamily:
        typeof identity.deviceFamily === "string" && identity.deviceFamily.trim()
          ? identity.deviceFamily.trim()
          : undefined,
      deviceToken:
        typeof operatorToken.token === "string" && operatorToken.token.trim()
          ? operatorToken.token.trim()
          : undefined,
    };
    return cachedGatewayDeviceIdentity;
  } catch {
    cachedGatewayDeviceIdentity = null;
    return null;
  }
}

/**
 * 获取或创建 TrackedRun 实例。
 * 每个 Gateway runId 对应一个 TrackedRun，用于跟踪该运行的状态机。
 * 若已存在则更新元数据，否则创建新实例。
 * @param input - runId、agentId、target、sessionKey 等
 * @returns TrackedRun 实例
 */
function getOrCreateTrackedRun(input: {
  runId: string;
  agentId: string;
  target: string;
  sessionKey: string;
  expectedSessionKey?: string | null;
}) {
  const existing = trackedRuns.get(input.runId);
  if (existing) {
    existing.agentId = input.agentId;
    existing.target = input.target;
    existing.sessionKey = input.sessionKey;
    existing.expectedSessionKey = input.expectedSessionKey ?? existing.expectedSessionKey;
    existing.lastEventAtMs = Date.now();
    return existing;
  }

  const trackedRun: TrackedRun = {
    runId: input.runId,
    agentId: input.agentId,
    target: input.target,
    sessionKey: input.sessionKey,
    expectedSessionKey: input.expectedSessionKey ?? null,
    createdAtMs: Date.now(),
    lastEventAtMs: Date.now(),
    lastRecoveryAtMs: 0,
    latestAssistantText: "",
    latestDeltaText: "",
    sequence: 0,
    terminalState: null,
    toolCallCount: 0,
    toolCallArgs: new Map(),
    pendingDeltaTimer: null,
    lastHistoryFingerprint: "",
    stableHistoryPasses: 0,
    lastHistoryErrorMessage: null,
    lastHistoryStopReason: null,
    forgetTimer: null,
  };
  trackedRuns.set(input.runId, trackedRun);
  return trackedRun;
}

/**
 * 清除 TrackedRun 上的所有定时器（delta 刷新和遗忘定时器）。
 * @param trackedRun - 目标 TrackedRun
 */
function clearTrackedRunTimer(trackedRun: TrackedRun) {
  if (trackedRun.pendingDeltaTimer) {
    globalThis.clearTimeout(trackedRun.pendingDeltaTimer);
    trackedRun.pendingDeltaTimer = null;
  }
  if (trackedRun.forgetTimer) {
    globalThis.clearTimeout(trackedRun.forgetTimer);
    trackedRun.forgetTimer = null;
  }
}

const FORGET_RUN_DELAY_MS = 300_000; // 5 minutes

/**
 * 延迟清理 TrackedRun（5 分钟后从内存中删除）。
 * 用于终态后保留一段时间，以防迟到的事件。
 * @param runId - 运行 ID
 */
function forgetTrackedRunLater(runId: string) {
  const trackedRun = trackedRuns.get(runId);
  if (!trackedRun || trackedRun.forgetTimer) {
    return;
  }
  trackedRun.forgetTimer = globalThis.setTimeout(() => {
    forgetTrackedRun(runId);
  }, FORGET_RUN_DELAY_MS);
}

/**
 * 立即从内存中删除 TrackedRun 并清理其定时器。
 * @param runId - 运行 ID
 */
function forgetTrackedRun(runId: string) {
  const trackedRun = trackedRuns.get(runId);
  if (!trackedRun) {
    return;
  }
  clearTrackedRunTimer(trackedRun);
  trackedRuns.delete(runId);
}

/**
 * OpenClaw 某些 subagent announce 场景下会出现“双通道完成态”：
 * 1. Gateway 先以 `announce:v1:...` runId 把最终回复流式推给当前 session；
 * 2. 随后宿主又通过 channel outbound 触发一次 `sendText()`，
 *    这次没有原始 runId，最终在 app 里落成一条新的 `customchat:...` 消息。
 *
 * 对 app 来说，这两条消息文本一致、目标一致，因此会被看成“重复回复”。
 * 这里做的是一个很窄的去重：
 * - 只记录最近 15 秒内的 `announce:v1:...` 最终文本
 * - 只在“没有 runId、没有附件、目标相同、文本完全相同”时判定为重复补发
 * - 保留前面的 announce SSE 流式效果，只抑制后面的 customchat 终态补发
 */
function normalizeAnnounceDedupeTarget(target: string) {
  return target.trim().toLowerCase();
}

function pruneRecentAnnounceDeliveries(nowMs = Date.now()) {
  for (const [target, entry] of recentAnnounceDeliveries.entries()) {
    if (nowMs - entry.atMs > RECENT_ANNOUNCE_TTL_MS) {
      recentAnnounceDeliveries.delete(target);
    }
  }
}

function rememberRecentAnnounceDelivery(target: string, runId: string, text: string) {
  const normalizedTarget = normalizeAnnounceDedupeTarget(target);
  if (!normalizedTarget || !text.trim()) {
    return;
  }
  const nowMs = Date.now();
  pruneRecentAnnounceDeliveries(nowMs);
  recentAnnounceDeliveries.set(normalizedTarget, {
    atMs: nowMs,
    runId,
    text,
  });
  pluginLog("delivery", "rememberRecentAnnounceDelivery", "→ stored", {
    target: normalizedTarget,
    runId,
    textLen: String(text.length),
  });
}

function matchRecentAnnounceDuplicate(target: string, text: string) {
  const normalizedTarget = normalizeAnnounceDedupeTarget(target);
  if (!normalizedTarget || !text.trim()) {
    return null;
  }
  const nowMs = Date.now();
  pruneRecentAnnounceDeliveries(nowMs);
  const matched = recentAnnounceDeliveries.get(normalizedTarget);
  if (!matched) {
    return null;
  }
  if (matched.text !== text || nowMs - matched.atMs > RECENT_ANNOUNCE_TTL_MS) {
    return null;
  }
  return matched;
}

/**
 * 递增 TrackedRun 的序列号并更新最后事件时间戳。
 * 序列号用于保证投递消息的顺序（seq guard）。
 * @param {TrackedRun} trackedRun - 跟踪的运行实例
 * @returns {number} 新的序列号
 */
function nextTrackedRunSequence(trackedRun: TrackedRun) {
  trackedRun.sequence += 1;
  trackedRun.lastEventAtMs = Date.now();
  return trackedRun.sequence;
}

/**
 * 向前端 App 发送投递消息（通过 WebSocket 队列）。
 * 这是插件向前端推送 delta/final/aborted/error 状态的核心出口。
 * @param accountConfig - 账户配置（用于连接 App WebSocket）
 * @param payload - 投递载荷（target、runId、text、state、attachments 等）
 * @returns 投递结果
 */
async function sendPortalDelivery(
  accountConfig: AccountConfig,
  payload: PortalDeliveryPayload,
) {
  pluginLog("delivery", "sendPortalDelivery", "← input", {
    target: payload.target,
    sessionKey: payload.sessionKey,
    runId: payload.runId,
    messageId: payload.messageId,
    state: payload.state,
    seq: String(payload.seq),
    textLen: String((payload.text ?? "").length),
    attachments: String(Array.isArray(payload.attachments) ? payload.attachments.length : 0),
    runtimeSteps: String(Array.isArray(payload.runtimeSteps) ? payload.runtimeSteps.length : 0),
  });
  return new Promise<unknown>((resolve, reject) => {
    const requestId = `${payload.runId}:${payload.seq}:${payload.state}:${crypto.randomUUID()}`;
    portalQueue.push({
      requestId,
      payload,
      accountConfig,
      resolve,
      reject,
      timeoutAtMs: Date.now() + PORTAL_SEND_TIMEOUT_MS,
    });
    void pumpPortalQueue();
  });
}

async function sendPortalRequestFrame(
  accountConfig: AccountConfig,
  frameType: "deliver" | "app_rpc",
  requestId: string,
  payload: unknown,
  rejectionMessage: string,
  timeoutAtMs = Date.now() + PORTAL_SEND_TIMEOUT_MS,
) {
  let attempt = 0;

  while (Date.now() <= timeoutAtMs) {
    try {
      await ensurePortalSocket(accountConfig);
      const socket = portalSocket;
      if (!socket || socket.readyState !== socket.OPEN) {
        throw new Error("customchat portal websocket not ready");
      }

      return await new Promise<unknown>((resolve, reject) => {
        const handleMessage = (event: MessageEvent) => {
          const raw =
            typeof event.data === "string"
              ? event.data
              : Buffer.isBuffer(event.data)
                ? event.data.toString("utf8")
                : String(event.data);
          let frame: JsonRecord;
          try {
            frame = JSON.parse(raw) as JsonRecord;
          } catch {
            return;
          }

          if (
            typeof frame.requestId !== "string" ||
            frame.requestId.trim() !== requestId
          ) {
            return;
          }

          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("close", handleClose);
          socket.removeEventListener("error", handleError);

          if (frame.ok === true) {
            resolve(frame.result ?? { ok: true });
            return;
          }

          reject(
            new Error(
              typeof frame.error === "string" && frame.error.trim()
                ? frame.error.trim()
                : rejectionMessage,
            ),
          );
        };

        const handleClose = () => {
          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("close", handleClose);
          socket.removeEventListener("error", handleError);
          reject(new Error("customchat portal websocket closed during request"));
        };

        const handleError = () => {
          socket.removeEventListener("message", handleMessage);
          socket.removeEventListener("close", handleClose);
          socket.removeEventListener("error", handleError);
          reject(new Error("customchat portal websocket error during request"));
        };

        socket.addEventListener("message", handleMessage);
        socket.addEventListener("close", handleClose);
        socket.addEventListener("error", handleError);
        socket.send(
          JSON.stringify({
            type: frameType,
            requestId,
            payload,
          }),
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        message === "customchat portal websocket not ready" ||
        message === "customchat portal websocket closed during request" ||
        message === "customchat portal websocket error during request" ||
        message === "customchat portal websocket error" ||
        message === "customchat portal websocket closed";

      if (!retryable) {
        throw error;
      }

      resetPortalSocket();
      const delay =
        PORTAL_RECONNECT_BACKOFF_MS[
          Math.min(attempt, PORTAL_RECONNECT_BACKOFF_MS.length - 1)
        ] ?? 4_000;
      attempt += 1;
      await sleep(delay);
    }
  }

  throw new Error("customchat portal request timed out");
}

export async function sendPortalAppRpc(
  method: string,
  params: JsonRecord = {},
) {
  const accountConfig = await resolveDefaultAccountConfig();
  const requestId = `app_rpc:${method}:${crypto.randomUUID()}`;
  pluginLog("rpc", "sendPortalAppRpc", `→ ${method}`, { requestId });
  return sendPortalRequestFrame(
    accountConfig,
    "app_rpc",
    requestId,
    { method, params },
    `customchat app_rpc:${method} rejected`,
  );
}

/**
 * 重置前端 App WebSocket 连接（关闭现有连接、清理状态）。
 */
function resetPortalSocket() {
  if (portalPingTimer) {
    globalThis.clearInterval(portalPingTimer);
    portalPingTimer = null;
  }
  if (portalSocket) {
    try {
      portalSocket.close();
    } catch {
      // Ignore close failures.
    }
  }
  portalSocket = null;
  portalSocketOpenPromise = null;
  portalSocketUrl = null;
}

/**
 * 启动前端 App WebSocket 连接的心跳定时器（每 15 秒发送应用层 ping）。
 * @param {WebSocket} socket - 前端连接的 WebSocket 实例
 */
function startPortalHeartbeat(socket: WebSocket) {
  if (portalPingTimer) {
    globalThis.clearInterval(portalPingTimer);
  }
  portalPingTimer = globalThis.setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
  }, 15_000);
}

/**
 * 确保与前端 App 的 WebSocket 连接已建立。
 * 如果已连接且 URL 匹配则直接返回，否则重新连接。
 * @param accountConfig - 账户配置
 */
async function ensurePortalSocket(accountConfig: AccountConfig) {
  const nextUrl = resolvePortalWsUrl(accountConfig);
  if (
    isPortalSocketConnected() &&
    portalSocketUrl === nextUrl
  ) {
    return;
  }

  if (portalSocketOpenPromise && portalSocketUrl === nextUrl) {
    return portalSocketOpenPromise;
  }

  resetPortalSocket();
  portalSocketUrl = nextUrl;

  portalSocketOpenPromise = new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(nextUrl);
    let settled = false;

    const finishError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      resetPortalSocket();
      reject(error);
    };

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          role: "plugin",
          protocol: 1,
        }),
      );
    });

    socket.addEventListener("error", () => {
      finishError(new Error("customchat portal websocket error"));
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        finishError(new Error("customchat portal websocket closed"));
      } else {
        resetPortalSocket();
      }
    });

    socket.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : Buffer.isBuffer(event.data)
            ? event.data.toString("utf8")
            : String(event.data);
      let frame: JsonRecord;
      try {
        frame = JSON.parse(raw) as JsonRecord;
      } catch {
        return;
      }

      const frameType = typeof frame.type === "string" ? frame.type : "";
      if (frameType === "hello") {
        settled = true;
        portalSocket = socket;
        startPortalHeartbeat(socket);
        // 注册持久的 inbound 消息处理器（App → Plugin 方向）
        socket.addEventListener("message", handlePortalInboundMessage);
        resolve();
      }
    });
  });

  return portalSocketOpenPromise;
}

/**
 * 启动前端 App bridge WebSocket 的后台保活循环。
 * App 重启导致 socket 断开后，会在后台自动重拨，保证 App → Plugin inbound/rpc 可恢复。
 */
function ensurePortalBridgeLoop() {
  if (portalBridgeLoopStarted) {
    return;
  }

  portalBridgeLoopStarted = true;
  globalThis.setInterval(() => {
    if (isPortalSocketConnected() || portalSocketOpenPromise) {
      return;
    }

    void resolveDefaultAccountConfig()
      .then((cfg) => ensurePortalSocket(cfg))
      .then(() => {
        portalReconnectAttempts = 0;
      })
      .catch(() => null);
  }, PORTAL_BRIDGE_RECONNECT_INTERVAL_MS);
}

/**
 * 发送单个投递信封到前端 App，带重试和指数退避。
 * @param item - 投递队列项
 * @returns 投递结果
 * @throws 超时时抛出 Error
 */
async function sendPortalEnvelope(item: PortalQueueItem) {
  return sendPortalRequestFrame(
    item.accountConfig,
    "deliver",
    item.requestId,
    item.payload,
    "customchat portal delivery rejected",
    item.timeoutAtMs,
  );
}

/**
 * 投递队列泵：串行处理队列中的投递请求。
 * 确保同一时间只有一个泵在运行（互斥）。
 */
async function pumpPortalQueue() {
  if (portalPumpActive) {
    return;
  }

  portalPumpActive = true;
  try {
    while (portalQueue.length > 0) {
      const current = portalQueue[0];
      try {
        const result = await sendPortalEnvelope(current);
        portalQueue.shift();
        current.resolve(result);
        portalReconnectAttempts = 0;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        if (Date.now() > current.timeoutAtMs) {
          portalQueue.shift();
          current.reject(new Error(message));
          continue;
        }
        portalReconnectAttempts += 1;
        await sleep(
          PORTAL_RECONNECT_BACKOFF_MS[
            Math.min(portalReconnectAttempts - 1, PORTAL_RECONNECT_BACKOFF_MS.length - 1)
          ] ?? 4_000,
        );
      }
    }
  } finally {
    portalPumpActive = false;
  }
}

/**
 * 向前端发送 TrackedRun 的状态更新（delta/final/aborted/error）。
 * delta 状态跳过空文本或未变化的文本（除非 force=true）。
 * 非 delta 状态会设置 terminalState 标记运行结束。
 * @param accountConfig - 账户配置
 * @param trackedRun - 目标 TrackedRun
 * @param state - 状态类型
 * @param text - 消息文本
 * @param options - 可选的 errorMessage、stopReason、force
 */
async function emitTrackedRunState(
  accountConfig: AccountConfig,
  trackedRun: TrackedRun,
  state: PortalDeliveryState,
  text: string,
  options?: {
    errorMessage?: string;
    stopReason?: string;
    force?: boolean;
  },
) {
  if (
    state === "delta" &&
    !options?.force &&
    (!text || text === trackedRun.latestDeltaText)
  ) {
    return;
  }

  if (state === "delta") {
    trackedRun.latestDeltaText = text;
  } else {
    trackedRun.terminalState = state;
  }

  await sendPortalDelivery(accountConfig, {
    target: trackedRun.target,
    sessionKey: trackedRun.sessionKey,
    runId: trackedRun.runId,
    seq: nextTrackedRunSequence(trackedRun),
    messageId: `${trackedRun.runId}:${state}:${Date.now()}`,
    text,
    state,
    attachments: [],
    errorMessage: options?.errorMessage,
    stopReason: options?.stopReason,
  });
}

/**
 * 排队延迟刷新 TrackedRun 的 delta 状态（80ms 防抖）。
 * 避免高频 delta 事件导致过多投递。
 * @param accountConfig - 账户配置
 * @param trackedRun - 目标 TrackedRun
 */
function queueTrackedRunDeltaFlush(accountConfig: AccountConfig, trackedRun: TrackedRun) {
  if (trackedRun.pendingDeltaTimer || trackedRun.terminalState) {
    return;
  }

  trackedRun.pendingDeltaTimer = globalThis.setTimeout(() => {
    trackedRun.pendingDeltaTimer = null;
    if (!trackedRun.latestAssistantText) {
      return;
    }
    void emitTrackedRunState(
      accountConfig,
      trackedRun,
      "delta",
      trackedRun.latestAssistantText,
    ).catch(() => null);
  }, 80);
}

/**
 * 立即刷新 TrackedRun 的 delta 状态（清除防抖定时器后发送）。
 * @param accountConfig - 账户配置
 * @param trackedRun - 目标 TrackedRun
 * @param force - 是否强制发送（即使文本未变化）
 */
async function flushTrackedRunDelta(
  accountConfig: AccountConfig,
  trackedRun: TrackedRun,
  force = false,
) {
  clearTrackedRunTimer(trackedRun);
  if (!trackedRun.latestAssistantText) {
    return;
  }
  await emitTrackedRunState(
    accountConfig,
    trackedRun,
    "delta",
    trackedRun.latestAssistantText,
    { force },
  );
}

/**
 * 从 Gateway 聊天历史中回填 TrackedRun 的助手文本。
 * 用于恢复场景：当实时事件丢失时，从历史记录中补全状态。
 * 同时检测历史记录的稳定性（连续相同 fingerprint 的次数）。
 * @param accountConfig - 账户配置
 * @param trackedRun - 目标 TrackedRun
 * @returns 历史状态信息（lastMessageRole、hasAssistantText、stableHistoryPasses 等）
 */
async function backfillTrackedRunFromHistory(
  accountConfig: AccountConfig,
  trackedRun: TrackedRun,
) {
  const historyPayload = await fetchGatewayChatHistory(trackedRun.sessionKey, 100).catch(() => null);
  const historyRecord = asJsonRecord(historyPayload);
  const historyMessages = Array.isArray(historyRecord.messages)
    ? historyRecord.messages
    : [];
  const latestUserTimestamp = historyMessages.reduce((latest, candidate) => {
    const messageRecord = asJsonRecord(candidate);
    const role =
      typeof messageRecord.role === "string"
        ? messageRecord.role.trim()
        : typeof messageRecord.kind === "string"
          ? messageRecord.kind.trim()
          : "";
    if (role !== "user") {
      return latest;
    }
    const timestamp =
      typeof messageRecord.timestamp === "number" && Number.isFinite(messageRecord.timestamp)
        ? messageRecord.timestamp
        : 0;
    return Math.max(latest, timestamp);
  }, 0);
  const historyMatchesTrackedRun =
    latestUserTimestamp > 0 &&
    latestUserTimestamp >= trackedRun.createdAtMs - 10_000;
  const currentTurnMessages = historyMatchesTrackedRun
    ? extractCurrentTurnMessages(historyMessages)
    : [];
  const latestText = currentTurnMessages
    .map((candidate) => {
      const messageRecord = asJsonRecord(candidate);
      const role =
        typeof messageRecord.role === "string"
          ? messageRecord.role.trim()
          : typeof messageRecord.kind === "string"
            ? messageRecord.kind.trim()
            : "";
      return role === "assistant" && !isDeliveryMirrorMessage(messageRecord)
        ? extractTextFromMessagePayload(candidate)
        : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (historyMatchesTrackedRun && latestText) {
    trackedRun.latestAssistantText = latestText;
  }

  const lastMessage = currentTurnMessages[currentTurnMessages.length - 1];
  const lastMessageRecord = asJsonRecord(lastMessage);
  const lastMessageRole =
    typeof lastMessageRecord.role === "string" ? lastMessageRecord.role.trim() : "";
  const lastHistoryErrorMessage =
    lastMessageRole === "assistant" &&
    typeof lastMessageRecord.errorMessage === "string" &&
    lastMessageRecord.errorMessage.trim()
      ? lastMessageRecord.errorMessage.trim()
      : null;
  const lastHistoryStopReason =
    lastMessageRole === "assistant" &&
    typeof lastMessageRecord.stopReason === "string" &&
    lastMessageRecord.stopReason.trim()
      ? lastMessageRecord.stopReason.trim()
      : null;
  const lastMessageTimestamp =
    typeof lastMessageRecord.timestamp === "number" && Number.isFinite(lastMessageRecord.timestamp)
      ? lastMessageRecord.timestamp
      : 0;
  trackedRun.lastHistoryErrorMessage = lastHistoryErrorMessage;
  trackedRun.lastHistoryStopReason = lastHistoryStopReason;
  const historyFingerprint = JSON.stringify({
    historyMatchesTrackedRun,
    latestUserTimestamp,
    count: currentTurnMessages.length,
    lastMessageRole,
    lastMessageTimestamp,
    latestText,
    lastHistoryErrorMessage,
    lastHistoryStopReason,
  });
  if (trackedRun.lastHistoryFingerprint === historyFingerprint) {
    trackedRun.stableHistoryPasses += 1;
  } else {
    trackedRun.lastHistoryFingerprint = historyFingerprint;
    trackedRun.stableHistoryPasses = 0;
  }

  return {
    lastMessageRole,
    hasAssistantText: Boolean(latestText),
    stableHistoryPasses: trackedRun.stableHistoryPasses,
    errorMessage: lastHistoryErrorMessage,
    stopReason: lastHistoryStopReason,
  };
}

/**
 * 调和 TrackedRun 的状态：从历史和 agent.wait 结果推断运行是否已结束。
 * 处理以下场景：运行仍在进行中、运行已完成、已中止、已出错。
 * 有节流保护（ACTIVE_RUN_RECOVERY_THROTTLE_MS）。
 * @param accountConfig - 账户配置
 * @param trackedRun - 目标 TrackedRun
 */
async function reconcileTrackedRun(
  accountConfig: AccountConfig,
  trackedRun: TrackedRun,
) {
  if (trackedRun.terminalState) {
    return;
  }

  const now = Date.now();
  if (now - trackedRun.lastRecoveryAtMs < ACTIVE_RUN_RECOVERY_THROTTLE_MS) {
    return;
  }
  trackedRun.lastRecoveryAtMs = now;

  const historyState = await backfillTrackedRunFromHistory(accountConfig, trackedRun);

  const waitPayload = await waitForGatewayRun(trackedRun.runId, 0).catch(() => null);
  const waitRecord = asJsonRecord(waitPayload);
  const waitStatus =
    typeof waitRecord.status === "string" ? waitRecord.status.trim() : "timeout";

  if (waitStatus === "timeout") {
    if (
      trackedRun.latestAssistantText &&
      historyState?.lastMessageRole === "assistant" &&
      historyState.stableHistoryPasses >= 1
    ) {
      await flushTrackedRunDelta(accountConfig, trackedRun, true).catch(() => null);
      await emitTrackedRunState(
        accountConfig,
        trackedRun,
        "final",
        trackedRun.latestAssistantText,
      ).catch(() => null);
      forgetTrackedRun(trackedRun.runId);
      return;
    }

    if (
      !trackedRun.latestAssistantText &&
      historyState?.lastMessageRole === "assistant" &&
      historyState.stableHistoryPasses >= 1 &&
      historyState.errorMessage
    ) {
      await emitTrackedRunState(
        accountConfig,
        trackedRun,
        "error",
        "",
        {
          errorMessage: historyState.errorMessage,
          stopReason: historyState.stopReason || undefined,
        },
      ).catch(() => null);
      forgetTrackedRun(trackedRun.runId);
      return;
    }

    if (trackedRun.latestAssistantText) {
      queueTrackedRunDeltaFlush(accountConfig, trackedRun);
    }
    return;
  }

  if (trackedRun.latestAssistantText) {
    await flushTrackedRunDelta(accountConfig, trackedRun, true).catch(() => null);
  }

  if (waitStatus === "aborted" || waitStatus === "cancelled" || waitStatus === "canceled") {
    await emitTrackedRunState(
      accountConfig,
      trackedRun,
      "aborted",
      trackedRun.latestAssistantText,
      { stopReason: "user aborted" },
    ).catch(() => null);
    forgetTrackedRun(trackedRun.runId);
    return;
  }

  if (waitStatus === "error") {
    await emitTrackedRunState(
      accountConfig,
      trackedRun,
      trackedRun.latestAssistantText ? "final" : "error",
      trackedRun.latestAssistantText,
      {
        errorMessage:
          typeof waitRecord.error === "string" && waitRecord.error.trim()
            ? waitRecord.error.trim()
            : historyState?.errorMessage
              ? historyState.errorMessage
            : trackedRun.latestAssistantText
              ? undefined
              : "Agent run failed.",
        stopReason: historyState?.stopReason || undefined,
      },
    ).catch(() => null);
    forgetTrackedRun(trackedRun.runId);
    return;
  }

  if (!trackedRun.latestAssistantText && historyState?.errorMessage) {
    await emitTrackedRunState(
      accountConfig,
      trackedRun,
      "error",
      "",
      {
        errorMessage: historyState.errorMessage,
        stopReason: historyState.stopReason || undefined,
      },
    ).catch(() => null);
    forgetTrackedRun(trackedRun.runId);
    return;
  }

  await emitTrackedRunState(
    accountConfig,
    trackedRun,
    "final",
    trackedRun.latestAssistantText,
  ).catch(() => null);
  forgetTrackedRun(trackedRun.runId);
}

/**
 * 恢复所有活跃的 TrackedRun。
 * 遍历内存中的 TrackedRun，清理过期的，对活跃的执行 reconcile。
 * 有互斥保护（gatewayRecoveryInFlight）。
 */
async function recoverTrackedRuns() {
  if (gatewayRecoveryInFlight) {
    return;
  }

  gatewayRecoveryInFlight = true;
  try {
    if (trackedRuns.size === 0) {
      return;
    }

    const accountConfig = await resolveDefaultAccountConfig();
    for (const trackedRun of Array.from(trackedRuns.values())) {
      if (Date.now() - trackedRun.createdAtMs > ACTIVE_RUN_STALE_TTL_MS) {
        forgetTrackedRun(trackedRun.runId);
        continue;
      }

      // 机制级防御：针对刚刚创建（<5s）且尚未接收到任何真实事件流的 Run，
      // 强行禁止做历史记录回填（避免因 OpenClaw 尚未把最新 user 消息落库而匹配到上文）。
      if (Date.now() - trackedRun.createdAtMs < 5000 && trackedRun.sequence === 0) {
        continue;
      }

      await reconcileTrackedRun(accountConfig, trackedRun).catch(() => null);
    }
  } finally {
    gatewayRecoveryInFlight = false;
  }
}

/**
 * 启动 Gateway 恢复定时循环（每 60 秒执行一次 recoverTrackedRuns）。
 */
function ensureGatewayRecoveryLoop() {
  ensureCustomChatRecoveryLoop({
    recoverTrackedRuns,
    intervalMs: ACTIVE_RUN_RECOVERY_INTERVAL_MS,
  });
}

/**
 * 从持久化的路由状态中恢复 TrackedRun。
 * 插件重启时调用，从 route-state.json 中读取最近 10 分钟内的绑定。
 */
async function restoreTrackedRunsFromRouteState() {
  const state = await readRouteState().catch(() => null);
  if (!state) {
    return;
  }

  const restoreCutoffMs = Date.now() - 10 * 60 * 1000;
  const bindings = state.bindings
    .filter((binding) => parseTimestampMs(binding.updatedAt) >= restoreCutoffMs)
    .sort((left, right) => parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt))
    .slice(0, RESTORED_TRACKED_RUN_LIMIT);

  for (const binding of bindings) {
    const latestRunId = binding.runIds[0];
    if (!latestRunId) {
      continue;
    }
    getOrCreateTrackedRun({
      runId: latestRunId,
      agentId: binding.agentId,
      target: binding.target,
      sessionKey:
        normalizeSessionKeyCandidate(binding.sessionKey) ||
        normalizeSessionKeyCandidate(binding.expectedSessionKey) ||
        buildCanonicalSessionKey(binding.agentId, binding.target),
      expectedSessionKey: binding.expectedSessionKey,
    });
  }
}

/**
 * 处理 Gateway agent 事件（event:agent）。
 *
 * 处理两类事件流：
 * - lifecycle: phase=start 重置已终结的 TrackedRun（处理 Gateway 重试），
 *   phase=end 作为兜底终结器（当 event:chat state=final 未到达时）。
 * - tool: phase=start/result 构建 runtimeStep 并以 delta 投递给前端，
 *   实现工具调用的实时 UI 展示。
 * @param payload - Gateway agent 事件载荷
 */
async function handleTrackedGatewayAgentEvent(payload: JsonRecord) {
  const stream = typeof payload.stream === "string" ? payload.stream : "(none)";
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const data = asJsonRecord(payload.data);
  console.log(`[customchat:stream] stream=${stream} runId=${runId} data=${JSON.stringify(data).slice(0, 500)}`);
  pluginLog("agent-event", "handleTrackedGatewayAgentEvent", "← input", { stream, runId, dataKeys: Object.keys(data).join(",") });

  if (!runId) return;

  if (stream === "assistant") {
    const trackedRun = trackedRuns.get(runId);
    if (!trackedRun) {
      console.log(`[customchat:stream] assistant event ignored: no trackedRun for runId=${runId}`);
      return;
    }

    const latestText = extractStringValue(data.text);
    const deltaText = extractStringValue(data.delta);
    if (latestText) {
      trackedRun.latestAssistantText = latestText;
    } else if (deltaText) {
      trackedRun.latestAssistantText += deltaText;
    } else {
      return;
    }

    const accountConfig = await resolveDefaultAccountConfig();
    queueTrackedRunDeltaFlush(accountConfig, trackedRun);
    return;
  }

  // Handle lifecycle phase=end: finalize any bubble that never received event:chat state=final
  // (e.g. agent ran tools but produced no text output).
  if (stream === "lifecycle") {
    const phase = extractStringValue(data.phase);

    // phase=start: if Gateway retries a run with the same runId (e.g. after LLM timeout),
    // reset the trackedRun so the retry's text/lifecycle events are processed normally.
    if (phase === "start") {
      const existing = trackedRuns.get(runId);
      if (existing?.terminalState) {
        console.log(`[customchat:lifecycle] phase=start runId=${runId}, resetting terminated trackedRun (was: ${existing.terminalState})`);
        existing.terminalState = null;
        existing.latestAssistantText = "";
        existing.latestDeltaText = "";
        existing.sequence = 0;
        existing.lastEventAtMs = Date.now();
        clearTrackedRunTimer(existing);
      }
      return;
    }

    if (phase !== "end") return;
    const trackedRun = trackedRuns.get(runId);
    if (!trackedRun) return;
    if (trackedRun.terminalState) {
      // Already finalized via event:chat state=final — nothing to do.
      return;
    }
    // Run ended without ever receiving event:chat state=final — finalize now.
    console.log(`[customchat:lifecycle] phase=end runId=${runId}, finalizing open trackedRun`);
    const accountConfig = await resolveDefaultAccountConfig();
    await flushTrackedRunDelta(accountConfig, trackedRun, true).catch(() => null);
    await emitTrackedRunState(
      accountConfig,
      trackedRun,
      "final",
      trackedRun.latestAssistantText,
    ).catch(() => null);
    forgetTrackedRunLater(trackedRun.runId);
    return;
  }

  if (stream !== "tool") return;

  const phase = extractStringValue(data.phase); // "start" | "result" | ...
  const toolName = extractStringValue(data.name) || "tool";
  const toolCallId = extractStringValue(data.toolCallId) || `tool-${Date.now()}`;

  // Only handle "start" and "result" phases.
  if (phase !== "start" && phase !== "result") return;

  const trackedRun = trackedRuns.get(runId);
  if (!trackedRun) {
    console.log(`[customchat:stream] tool event ignored: no trackedRun for runId=${runId}`);
    return;
  }

  const accountConfig = await resolveDefaultAccountConfig();

  // Build a runtimeStep from the tool event.
  // The raw data keys must match what the app's describeRuntimeData() expects:
  //   - "name" → tool name detection
  //   - "phase" → "start"/"end" for status
  //   - "query"/"command"/"path" → description text
  //   - "result" → detail text
  const argsRecord = asJsonRecord(data.args || data.arguments || data.input || {});
  const isError = data.isError === true;
  const meta = extractStringValue(data.meta);

  // Cache args on start, reuse on result (result events don't carry args)
  if (phase === "start" && Object.keys(argsRecord).length > 0) {
    trackedRun.toolCallArgs.set(toolCallId, argsRecord);
  }
  const cachedArgs = trackedRun.toolCallArgs.get(toolCallId) || argsRecord;

  // Format args as readable detail text for the expanded view
  const argsDetail = Object.keys(cachedArgs).length > 0
    ? Object.entries(cachedArgs)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n")
    : null;

  // On result phase with verboseDefault=full, data.result contains actual tool output.
  // Structure: {content: [{type: "text", text: "..."}]} or a plain string.
  /** 从工具调用结果中提取文本内容（支持 string / {content:[{text}]} 结构）。 */
  function extractToolResultText(raw: unknown): string | null {
    if (typeof raw === "string") return raw;
    const rec = asJsonRecord(raw);
    const content = Array.isArray(rec.content) ? rec.content : [];
    for (const item of content) {
      const entry = asJsonRecord(item);
      const text = extractStringValue(entry.text);
      if (text) return text;
    }
    // Fallback: try direct text field
    return extractStringValue(rec.text) || extractStringValue(rec.output) || null;
  }

  const toolResult = phase === "result"
    ? extractToolResultText(data.result) || extractToolResultText(data.partialResult) || null
    : null;
  // Use tool output as detail if available, otherwise fall back to args
  const detailText = toolResult
    ? (toolResult.length > 1200 ? toolResult.slice(0, 1200) + "..." : toolResult)
    : argsDetail;

  const runtimeStep = {
    id: toolCallId,
    stream: "tool",
    ts: Date.now(),
    data: {
      // Keys that describeRuntimeData picks up:
      name: toolName,
      phase: phase === "result" ? (isError ? "error" : "end") : "start",
      // Spread cached args so query/command/path etc. are directly available
      ...cachedArgs,
      // Tool output or args as detail (stdout → picked up by describeRuntimeData)
      ...(detailText ? { stdout: detailText } : {}),
      ...(isError ? { error: meta || "tool execution failed" } : {}),
    },
  };

  console.log(`[customchat:tool-step] runId=${trackedRun.runId} phase=${phase} tool=${toolName} id=${toolCallId}`);

  // Send runtimeStep as a delta delivery on the MAIN message runId.
  await sendPortalDelivery(accountConfig, {
    target: trackedRun.target,
    sessionKey: trackedRun.sessionKey,
    runId: trackedRun.runId,
    seq: nextTrackedRunSequence(trackedRun),
    messageId: trackedRun.runId,
    text: trackedRun.latestAssistantText,
    state: "delta",
    attachments: [],
    runtimeSteps: [runtimeStep],
  }).catch((err) => {
    console.error(`[customchat:tool-step] delivery failed:`, err);
  });
}

/**
 * 处理 Gateway chat 事件（event:chat）。
 *
 * 根据 runId 查找或恢复对应的 TrackedRun，然后：
 * - delta 状态：更新助手文本，排队防抖投递
 * - final/aborted/error 状态：刷新 delta，发送终态投递，延迟清理 TrackedRun
 *
 * 支持"即兴绑定恢复"：当 sessionKey 符合 customchat 格式但无已知绑定时，
 * 自动解析 target 并创建 TrackedRun。
 * @param payload - Gateway chat 事件载荷
 */
async function handleTrackedGatewayChatEvent(payload: JsonRecord) {
  const runId = typeof payload.runId === "string" ? payload.runId.trim() : "";
  const sessionKey =
    typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  const chatState = typeof payload.state === "string" ? payload.state : "";
  const chatMessage = asJsonRecord(payload.message);
  pluginLog("chat-event", "handleTrackedGatewayChatEvent", "← input", {
    runId,
    sessionKey,
    state: chatState,
    textLen: String(typeof payload.text === "string" ? payload.text.length : 0),
  });
  pluginLog("chat-event", "handleTrackedGatewayChatEvent", "← message-meta", {
    provider: typeof chatMessage.provider === "string" ? chatMessage.provider : "",
    model: typeof chatMessage.model === "string" ? chatMessage.model : "",
    api: typeof chatMessage.api === "string" ? chatMessage.api : "",
    role: typeof chatMessage.role === "string" ? chatMessage.role : "",
    sourceTool: typeof chatMessage.sourceTool === "string" ? chatMessage.sourceTool : "",
    sourceSessionKey:
      typeof chatMessage.sourceSessionKey === "string" ? chatMessage.sourceSessionKey : "",
    hasProvenance: chatMessage.provenance != null,
    provenanceKeys:
      chatMessage.provenance && typeof chatMessage.provenance === "object"
        ? Object.keys(chatMessage.provenance as JsonRecord).join(",")
        : "",
    metadataKeys:
      chatMessage.metadata && typeof chatMessage.metadata === "object"
        ? Object.keys(chatMessage.metadata as JsonRecord).join(",")
        : "",
  });
  if (!runId || !sessionKey || isDeliveryMirrorMessage(payload.message)) {
    pluginLog("chat-event", "handleTrackedGatewayChatEvent", "→ skipped", { runId, sessionKey, reason: "empty or mirror" });
    return;
  }

  const remembered = trackedRuns.get(runId) ?? await findRouteBinding({ runId, sessionKey });
  let trackedRun: TrackedRun | null = null;
  if (remembered && "runId" in remembered) {
    trackedRun = remembered as TrackedRun;
  } else if (remembered) {
    trackedRun = getOrCreateTrackedRun({
      runId,
      agentId: remembered.agentId,
      target: remembered.target,
      sessionKey:
        normalizeSessionKeyCandidate(remembered.sessionKey) ||
        normalizeSessionKeyCandidate(remembered.expectedSessionKey) ||
        sessionKey,
      expectedSessionKey: remembered.expectedSessionKey,
    });
  }

  if (!trackedRun) {
    // IMPROVISATIONAL BINDING RECOVERY:
    // If we don't know this run or session, but the sessionKey looks like it's ours,
    // we can "improvise" a binding by parsing the key.
    // Format: agent:<agentId>:customchat:channel:<panelId>
    const parts = sessionKey.split(":");
    if (
      parts.length >= 5 &&
      parts[0] === "agent" &&
      parts[2] === "customchat"
    ) {
      const agentId = parts[1];
      const target = normalizeChannelTarget(sessionKey);
      if (target) {
        console.log(`[customchat] Recovering lost binding for session: ${sessionKey} -> ${target}`);
        trackedRun = getOrCreateTrackedRun({
          runId,
          agentId,
          target,
          sessionKey,
        });
      }
    }
  }

  if (!trackedRun) {
    console.log(`[customchat:chat] no trackedRun for runId=${runId} sessionKey=${sessionKey}`);
    return;
  }

  clearTrackedRunTimer(trackedRun);

  const accountConfig = await resolveDefaultAccountConfig();
  const text = extractTextFromMessagePayload(chatMessage);
  if (text) {
    trackedRun.latestAssistantText = text;
  }

  const rawState = typeof payload.state === "string" ? payload.state.trim() : "final";

  console.log(`[customchat:chat] runId=${trackedRun.runId} state=${rawState} textLen=${text.length} latestLen=${trackedRun.latestAssistantText.length}`);

  if (rawState === "delta") {
    queueTrackedRunDeltaFlush(accountConfig, trackedRun);
    return;
  }

  // Final: flush any pending delta, then emit the final text bubble.
  // Tool-call bubbles are now emitted in real time via stream=tool events.
  await flushTrackedRunDelta(accountConfig, trackedRun, true).catch(() => null);
  // 记录最近一次 announce:v1 最终态，供 deliverMessage() 识别
  // 随后由宿主 OpenClaw 触发的重复 outbound sendText 补发。
  if (trackedRun.runId.startsWith("announce:v1:") && trackedRun.latestAssistantText.trim()) {
    rememberRecentAnnounceDelivery(
      trackedRun.target,
      trackedRun.runId,
      trackedRun.latestAssistantText,
    );
  }
  await emitTrackedRunState(
    accountConfig,
    trackedRun,
    rawState as PortalDeliveryState,
    trackedRun.latestAssistantText,
    {
      errorMessage:
        typeof payload.errorMessage === "string" ? payload.errorMessage : undefined,
    },
  ).catch(() => null);
  forgetTrackedRunLater(trackedRun.runId);
}

/**
 * 启动基于官方 GatewayClient 的订阅连接。
 * 这样可以直接复用宿主 OpenClaw 当前版本的握手、签名和自动重连逻辑，
 * 避免插件自己手写协议细节导致的版本兼容问题。
 */
async function startGatewaySubscriberClient() {
  if (customChatRuntimeStore.activeGatewayClient) {
    return customChatRuntimeStore.activeGatewayClient;
  }

  const gatewayIdentity = await loadGatewayDeviceIdentity();
  if (!gatewayIdentity) {
    throw new Error("OpenClaw device identity is missing on the gateway host.");
  }

  const gatewayAuthToken = await resolveGatewayAuthToken();
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  const client = new GatewayClient({
    url: await resolveGatewayWsUrl(),
    token: gatewayAuthToken || undefined,
    role: "operator",
    scopes,
    mode: "cli",
    clientName: "cli",
    clientDisplayName: "Custom Chat Plugin",
    clientVersion: "1.0.0",
    platform: gatewayIdentity.platform,
    deviceFamily: gatewayIdentity.deviceFamily,
    deviceIdentity: {
      deviceId: gatewayIdentity.deviceId,
      publicKeyPem: gatewayIdentity.publicKeyPem,
      privateKeyPem: gatewayIdentity.privateKeyPem,
    },
    caps: ["tool-events"],
    connectChallengeTimeoutMs: GATEWAY_SUBSCRIBER_CONNECT_TIMEOUT_MS,
    onHelloOk: () => {
      customChatRuntimeStore.activeGatewayClient = client;
      recordGatewaySubscriberConnected();
      console.log("[customchat] gateway subscriber connected");
      ensureGatewayRecoveryLoop();
      void recoverTrackedRuns().catch(() => null);
    },
    onConnectError: (error) => {
      recordGatewaySubscriberError(error);
      console.error("[customchat] gateway subscriber connect failed", error.message);
    },
    onClose: (_code, reason) => {
      customChatRuntimeStore.gatewayConnected = false;
      customChatRuntimeStore.activeGatewayWebSocket = null;
      console.error("[customchat] gateway subscriber closed", reason || "");
    },
    onEvent: (frame) => {
      void (async () => {
        const payload = asJsonRecord(frame.payload);
        pluginLog("gateway-event", "startGatewaySubscriberClient", "← frame", {
          event: typeof frame.event === "string" ? frame.event : "",
          runId:
            typeof payload.runId === "string"
              ? payload.runId
              : "",
          sessionKey:
            typeof payload.sessionKey === "string"
              ? payload.sessionKey
              : "",
          stream:
            typeof payload.stream === "string"
              ? payload.stream
              : "",
          state:
            typeof payload.state === "string"
              ? payload.state
              : "",
          payloadKeys: Object.keys(payload).join(","),
        });
        if (frame.event === "chat") {
          await handleTrackedGatewayChatEvent(payload);
          return;
        }
        if (frame.event === "agent") {
          await handleTrackedGatewayAgentEvent(payload);
          return;
        }
        pluginLog("gateway-event", "startGatewaySubscriberClient", "→ ignored", {
          event: typeof frame.event === "string" ? frame.event : "",
        });
      })().catch((error) => {
        console.error("[customchat] gateway subscriber frame failure", error);
      });
    },
  });

  customChatRuntimeStore.activeGatewayClient = client;
  client.start();
  return client;
}

/**
 * 启动 Gateway WebSocket 订阅后台循环（仅执行一次）。
 * 断线后自动重连，同时恢复持久化的 TrackedRun 和启动恢复定时器。
 */
function ensureGatewaySubscriber() {
  if (customChatRuntimeStore.gatewaySubscriberLoopStarted) {
    return;
  }
  markGatewaySubscriberLoopStarted();
  ensureGatewayRecoveryLoop();
  void restoreTrackedRunsFromRouteState().catch(() => null);
  void startGatewaySubscriberClient().catch((error) => {
    recordGatewaySubscriberError(error);
    console.error("[customchat] gateway subscriber failure", error);
  });
}

/**
 * 发起一轮聊天：向 Gateway 发送用户消息并获取 runId。
 * 发送后异步解析实际会话键。
 * @param input - agentId、target、message、messageId
 * @returns runId、status、sessionKey、expectedSessionKey
 */
async function launchChatTurn(input: LaunchChatTurnInput) {
  const startedAtMs = Date.now();
  const expectedSessionKey = buildCanonicalSessionKey(input.agentId, input.target);
  pluginLog("inbound", "launchChatTurn", "→ sendGatewayChatTurn", {
    agentId: input.agentId,
    target: input.target,
    expectedSessionKey,
    messageId: input.messageId,
    textLen: String(input.message.length),
  });
  const payload = await sendGatewayChatTurn({
    sessionKey: expectedSessionKey,
    idempotencyKey: input.messageId,
    message: input.message,
    originatingChannel: "customchat",
    originatingTo: input.target,
  });

  const payloadRecord = asJsonRecord(payload);
  const payloadResult = asJsonRecord(payloadRecord.result);
  const runId =
    (typeof payloadRecord.runId === "string" && payloadRecord.runId.trim()) ||
    (typeof payloadResult.runId === "string" && payloadResult.runId.trim()) ||
    input.messageId;

  const sessionKey =
    (await resolveActualSessionKey({
      agentId: input.agentId,
      target: input.target,
      expectedSessionKey,
      startedAtMs,
    })) || expectedSessionKey;

  pluginLog("inbound", "launchChatTurn", "← result", {
    agentId: input.agentId,
    target: input.target,
    runId,
    sessionKey,
    expectedSessionKey,
  });

  return {
    runId,
    status: "started",
    sessionKey,
    expectedSessionKey,
  };
}

/**
 * 将入站附件物化到本地文件系统。
 * 将 base64 内容写入磁盘，生成 manifest.json，对文本类文件提取内容。
 * @param target - 投递目标
 * @param messageId - 消息 ID
 * @param attachments - 入站附件列表
 * @returns 物化后的文件列表和 manifest 路径
 */
async function materializeInboundAttachments(
  target: string,
  messageId: string,
  attachments: InboundAttachmentPayload[],
) {
  if (attachments.length === 0) {
    return {
      files: [] as Array<{
        name: string;
        mimeType: string;
        path: string;
        size: number;
        extractedText: string | null;
      }>,
      manifestPath: null as string | null,
    };
  }

  const sessionDir = path.join(
    CUSTOMCHAT_STORAGE_ROOT,
    normalizePathSegment(target, "channel"),
    normalizePathSegment(messageId, "message"),
  );
  await fs.mkdir(sessionDir, { recursive: true });

  const files: Array<{
    name: string;
    mimeType: string;
    path: string;
    size: number;
    extractedText: string | null;
  }> = [];

  for (const entry of attachments) {
    const filename = sanitizeFilename(entry.name);
    const bytes = Buffer.from(entry.content, "base64");
    const targetPath = path.join(sessionDir, `${crypto.randomUUID()}-${filename}`);
    await fs.writeFile(targetPath, bytes);
    files.push({
      name: filename,
      mimeType: entry.mimeType || "application/octet-stream",
      path: targetPath,
      size: entry.size ?? bytes.byteLength,
      extractedText: isTextLikeFile(filename, entry.mimeType || "")
        ? bytes.toString("utf8").trim().slice(0, 4000) || null
        : null,
    });
  }

  const manifestPath = path.join(sessionDir, "manifest.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        target,
        messageId,
        createdAt: new Date().toISOString(),
        files: files.map((file) => ({
          name: file.name,
          mimeType: file.mimeType,
          path: file.path,
          size: file.size,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { files, manifestPath };
}

/**
 * 构建并发送投递载荷到前端 App。
 * 从 body 中提取 target、sessionKey、runId、text、state 等字段。
 * @param accountConfig - 账户配置
 * @param body - 投递请求体
 * @returns 投递结果
 * @throws 缺少必要字段时抛出 Error
 */
async function postDelivery(accountConfig: AccountConfig, body: JsonRecord) {
  const target =
    typeof body.target === "string" ? body.target.trim() : "";
  const sessionKey =
    typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
  const runId =
    (typeof body.runId === "string" && body.runId.trim()) ||
    (typeof body.messageId === "string" && body.messageId.trim()) ||
    "";
  const seq = typeof body.seq === "number" && Number.isFinite(body.seq) ? body.seq : 0;
  const messageId =
    typeof body.messageId === "string" && body.messageId.trim()
      ? body.messageId.trim()
      : `${runId || "customchat"}:${crypto.randomUUID()}`;
  const state =
    typeof body.state === "string" &&
    ["delta", "final", "aborted", "error"].includes(body.state)
      ? (body.state as PortalDeliveryState)
      : "final";
  const text = typeof body.text === "string" ? body.text : "";
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as AttachmentPayload[])
    : [];
  const runtimeSteps = Array.isArray(body.runtimeSteps)
    ? (body.runtimeSteps as Array<{
        id: string;
        stream: string;
        ts: number;
        data: JsonRecord;
      }>)
    : undefined;

  if (!target || !sessionKey || !runId) {
    throw new Error("customchat delivery requires target, sessionKey, and runId");
  }

  pluginLog("delivery", "postDelivery", "→ normalized", {
    target,
    sessionKey,
    runId,
    messageId,
    state,
    seq: String(seq),
    textLen: String(text.length),
    attachments: String(attachments.length),
    runtimeSteps: String(Array.isArray(runtimeSteps) ? runtimeSteps.length : 0),
    bodyKeys: Object.keys(body).join(","),
  });

  return sendPortalDelivery(accountConfig, {
    target,
    sessionKey,
    runId,
    seq,
    messageId,
    text,
    state,
    attachments,
    runtimeSteps,
    errorMessage:
      typeof body.errorMessage === "string" ? body.errorMessage : undefined,
    usage: body.usage,
    stopReason:
      typeof body.stopReason === "string" ? body.stopReason : undefined,
  });
}

/**
 * 投递 Agent 出站消息到前端 App。
 * 解析目标、提取文本和媒体附件、查找路由绑定、执行投递。
 * 这是 Gateway message 工具的出站处理入口。
 * @param input - 出站消息载荷
 * @param accountConfig - 账户配置
 * @returns 投递结果
 */
async function deliverMessage(input: unknown, accountConfig: AccountConfig, ctxRunId?: string) {
  const runId = extractRunId(input) || ctxRunId?.trim() || null;
  const sessionKeyHint = extractSessionKeyHint(input);
  const messageId = buildMessageId(input);
  const inputRecord = asJsonRecord(input);
  const stackPreview = (new Error().stack || "")
    .split("\n")
    .slice(2, 6)
    .map((line) => line.trim())
    .join(" | ");
  pluginLog("delivery", "deliverMessage", "← input", {
    ctxRunId: ctxRunId || "",
    extractedRunId: runId || "",
    messageId,
    state:
      typeof inputRecord.state === "string"
        ? inputRecord.state
        : "",
    role:
      typeof inputRecord.role === "string"
        ? inputRecord.role
        : "",
    sourceTool:
      typeof inputRecord.sourceTool === "string"
        ? inputRecord.sourceTool
        : "",
    sourceSessionKey:
      typeof inputRecord.sourceSessionKey === "string"
        ? inputRecord.sourceSessionKey
        : "",
    inputKeys: Object.keys(inputRecord).join(","),
    stack: stackPreview,
  });
  const explicitTarget = (() => {
    try {
      return extractTarget(input);
    } catch {
      return null;
    }
  })();
  const remembered = await findRouteBinding({
    runId,
    target: explicitTarget,
    sessionKey: sessionKeyHint,
  });
  const target = explicitTarget || remembered?.target;
  if (!target) {
    throw new Error("customchat target is required.");
  }

  const rawText = extractText(input);
  const text = stripMediaRefsFromText(rawText);
  const record = input && typeof input === "object" ? (input as JsonRecord) : null;
  const mediaRefsFromText = extractMediaRefsFromText(rawText);
  const attachments = await toAttachmentList(
    [
      ...(record
        ? [
          record.media,
          record.attachments,
          record.files,
          record.mediaUrl,
          record.mediaUrls,
          record.path,
          record.filePath,
          record.url,
          record.file,
          record.fileUrl,
        ]
        : []),
      mediaRefsFromText,
    ],
  );

  const agentId =
    remembered?.agentId ||
    (typeof record?.agentId === "string" && record.agentId.trim()
      ? record.agentId.trim()
      : "main");
  const sessionKey = buildCanonicalSessionKey(agentId, target);

  pluginLog("delivery", "deliverMessage", "→ resolved", {
    target,
    explicitTarget: explicitTarget || "",
    rememberedTarget: remembered?.target || "",
    rememberedAgentId: remembered?.agentId || "",
    agentId,
    runId: runId || "",
    messageId,
    sessionKey,
    sessionKeyHint: sessionKeyHint || "",
    textLen: String(text.length),
    attachments: String(attachments.length),
  });

  const matchedAnnounce =
    !runId && attachments.length === 0 ? matchRecentAnnounceDuplicate(target, text) : null;
  if (matchedAnnounce) {
    // 这里拦的是 OpenClaw 宿主在 subagent announce 结束后补发的第二条完整文本。
    // 第一条 announce:v1 SSE 已经成功展示，所以直接短路返回，避免 app 落两条相同回复。
    pluginLog("delivery", "deliverMessage", "→ suppressed-duplicate-announce", {
      target,
      messageId,
      matchedRunId: matchedAnnounce.runId,
      textLen: String(text.length),
      ageMs: String(Date.now() - matchedAnnounce.atMs),
    });
    return {
      ok: true,
      suppressed: true,
      reason: "duplicate-announce-followup",
      target,
      matchedRunId: matchedAnnounce.runId,
      messageId,
    };
  }

  await rememberRouteBinding({
    target,
    agentId,
    runId,
    messageId,
    sessionKey,
    expectedSessionKey: sessionKey,
  });

  return postDelivery(accountConfig, {
    target,
    sessionKey,
    runId: runId || undefined,
    messageId,
    text,
    state:
      record &&
        typeof record.state === "string"
        ? record.state
        : "final",
    attachments,
  });
}

/**
 * 处理 inbound 用户消息的核心逻辑（传输无关）。
 * 解析载荷 → 物化附件 → 发起 chat.send → 创建 TrackedRun。
 * 由 HTTP handler 和 WebSocket handler 共用。
 */
async function processInboundPayload(parsed: InboundRequestPayload) {
  const target = normalizeChannelTarget(parsed.target || `channel:${parsed.panelId || ""}`);
  if (!target) {
    throw new Error("target is required.");
  }

  const messageId = parsed.messageId?.trim() || `customchat:${crypto.randomUUID()}`;
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  pluginLog("inbound", "processInboundPayload", "← input", {
    target,
    panelId: parsed.panelId || "",
    agentId: parsed.agentId || "",
    messageId,
    textLen: String((parsed.text || "").length),
    attachments: String(attachments.length),
  });
  const materialized = await materializeInboundAttachments(
    target,
    messageId,
    attachments,
  );
  const message = buildInboundAgentMessage(
    target,
    parsed.text || "",
    materialized.files,
    materialized.manifestPath,
  );
  const agentId = parsed.agentId?.trim() || "main";
  const launched = await launchChatTurn({
    agentId,
    target,
    message,
    messageId,
  });
  await rememberRouteBinding({
    target,
    agentId,
    runId: launched.runId,
    messageId,
    sessionKey: launched.sessionKey,
    expectedSessionKey: launched.expectedSessionKey,
  });
  getOrCreateTrackedRun({
    runId: launched.runId,
    agentId,
    target,
    sessionKey: launched.sessionKey,
    expectedSessionKey: launched.expectedSessionKey,
  });
  ensureGatewaySubscriber();

  pluginLog("inbound", "processInboundPayload", "← launched", {
    target,
    agentId,
    messageId,
    runId: launched.runId,
    sessionKey: launched.sessionKey,
    expectedSessionKey: launched.expectedSessionKey,
    files: String(materialized.files.length),
  });

  return {
    ok: true,
    status: launched.status,
    runId: launched.runId,
    target,
    sessionKey: launched.sessionKey,
    fileCount: materialized.files.length,
    manifestPath: materialized.manifestPath,
  };
}

// ── RPC dispatch (App → Plugin 管理类 API) ─────────────────────────

/**
 * 根据 method 名分派到对应的内部函数。
 * method 命名约定: "domain.action"，如 "agents.list", "session.delete" 等。
 */
async function dispatchRpcMethod(method: string, params: JsonRecord): Promise<unknown> {
  switch (method) {
    case "agents.list": {
      const agents = await listAgents();
      return { ok: true, agents };
    }

    case "agent.avatar": {
      const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      if (!agentId) {
        throw new Error("agentId is required.");
      }
      const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      const list = config?.agents?.list || [];
      const defaults = config?.agents?.defaults || {};
      const record = list.find((candidate: unknown) => {
        const agent = toAgentView(asJsonRecord(candidate));
        return agent?.id === agentId;
      });
      if (!record) {
        throw new Error("Agent not found.");
      }
      const enrichedRecord = {
        ...record,
        workspace: record.workspace || defaults.workspace,
        agentDir: record.agentDir || path.join(os.homedir(), ".openclaw", "agents", agentId, "agent"),
      };
      const avatarPath = await findAgentAvatarPath(enrichedRecord, agentId);
      if (!avatarPath) {
        throw new Error("Avatar not found.");
      }
      const content = await fs.readFile(avatarPath);
      return {
        ok: true,
        mimeType: guessImageMimeType(avatarPath),
        base64: content.toString("base64"),
      };
    }

    case "session.inspect": {
      const result = await inspectCustomChatSession({
        target: typeof params.target === "string" ? params.target : null,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
        runId: typeof params.runId === "string" ? params.runId : null,
        agentId: typeof params.agentId === "string" ? params.agentId : null,
        panelId: typeof params.panelId === "string" ? params.panelId : null,
      });
      return { ok: true, ...result };
    }

    case "session.status": {
      const result = await readCustomChatSessionStatus({
        target: typeof params.target === "string" ? params.target : null,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
        runId: typeof params.runId === "string" ? params.runId : null,
        agentId: typeof params.agentId === "string" ? params.agentId : null,
        panelId: typeof params.panelId === "string" ? params.panelId : null,
      });
      return { ok: true, ...result };
    }

    case "session.abort": {
      const result = await abortCustomChatSession({
        target: typeof params.target === "string" ? params.target : null,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey : null,
        runId: typeof params.runId === "string" ? params.runId : null,
        agentId: typeof params.agentId === "string" ? params.agentId : null,
        panelId: typeof params.panelId === "string" ? params.panelId : null,
      });
      return { ...result };
    }

    case "session.delete": {
      const target = normalizeChannelTarget(
        (typeof params.target === "string" ? params.target : "") ||
        `channel:${typeof params.panelId === "string" ? params.panelId : ""}`,
      );
      if (!target) {
        throw new Error("target is required.");
      }
      const remembered = await findRouteBinding({
        target,
        sessionKey: typeof params.sessionKey === "string" ? params.sessionKey.trim() : null,
      });
      const agentId = (typeof params.agentId === "string" && params.agentId.trim()) || remembered?.agentId || "main";
      const key =
        normalizeSessionKeyCandidate(typeof params.sessionKey === "string" ? params.sessionKey : null) ||
        normalizeSessionKeyCandidate(remembered?.sessionKey) ||
        normalizeSessionKeyCandidate(remembered?.expectedSessionKey) ||
        buildCanonicalSessionKey(agentId, target);

      const deleteKeys = new Set<string>();
      deleteKeys.add(key);
      if (!key.includes(":group:")) {
        deleteKeys.add(key.replace(":customchat:", ":customchat:group:"));
      }
      if (key.includes(":group:")) {
        deleteKeys.add(key.replace(":group:", ":"));
      }

      const deleteTranscript = params.deleteTranscript !== false;
      for (const k of deleteKeys) {
        deleteGatewaySession(k, deleteTranscript).catch((error) => {
          console.error(`[customchat] rpc session.delete failed for ${k}:`, error);
        });
      }

      await removeRouteBinding({
        target,
        sessionKey: key,
        expectedSessionKey: remembered?.expectedSessionKey || key,
      });

      return { ok: true, keys: Array.from(deleteKeys) };
    }

    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
}

/**
 * 持久 WebSocket 消息处理器：处理 App 发来的 inbound / rpc 消息。
 * 注册在 portal socket 上，与 sendPortalEnvelope 的 per-request ack 监听共存。
 */
function handlePortalInboundMessage(event: MessageEvent) {
  const raw =
    typeof event.data === "string"
      ? event.data
      : Buffer.isBuffer(event.data)
        ? event.data.toString("utf8")
        : String(event.data);
  let frame: JsonRecord;
  try {
    frame = JSON.parse(raw) as JsonRecord;
  } catch {
    return;
  }

  if (typeof frame.type !== "string" || (frame.type !== "inbound" && frame.type !== "rpc")) {
    return; // 非 inbound/rpc 消息，交给其他 handler 处理
  }

  const requestId = typeof frame.requestId === "string" ? frame.requestId : "";

  const sendAck = (ok: boolean, data: unknown) => {
    if (portalSocket && portalSocket.readyState === portalSocket.OPEN) {
      portalSocket.send(
        JSON.stringify(
          ok
            ? { type: "ack", requestId, ok: true, result: data }
            : { type: "ack", requestId, ok: false, error: data },
        ),
      );
    }
  };

  if (frame.type === "inbound") {
    const payload = frame.payload as InboundRequestPayload | undefined;
    void (async () => {
      try {
        if (!payload) {
          throw new Error("Invalid inbound payload.");
        }
        pluginLog("inbound", "handlePortalInboundMessage", "← received", {
          requestId,
          target: payload.target || "",
          messageId: payload.messageId || "",
        });
        const result = await processInboundPayload(payload);
        sendAck(true, result);
      } catch (error) {
        console.error("[customchat] inbound WS handler error", error);
        sendAck(false, error instanceof Error ? error.message : "customchat inbound failed.");
      }
    })();
    return;
  }

  if (frame.type === "rpc") {
    const rpcPayload = frame.payload as JsonRecord | undefined;
    const method = typeof rpcPayload?.method === "string" ? rpcPayload.method : "";
    const params = (rpcPayload?.params && typeof rpcPayload.params === "object" ? rpcPayload.params : {}) as JsonRecord;

    void (async () => {
      try {
        pluginLog("rpc", "handlePortalRpc", `← ${method}`, { requestId });
        const result = await dispatchRpcMethod(method, params);
        sendAck(true, result);
      } catch (error) {
        console.error(`[customchat] rpc:${method} error`, error);
        sendAck(false, error instanceof Error ? error.message : `rpc:${method} failed.`);
      }
    })();
    return;
  }
}

/**
 * 处理前端入站 HTTP 请求（POST /customchat/inbound）。
 * 验证 Bearer Token → 委托 processInboundPayload 处理。
 * GET 请求返回频道状态信息。
 * @param req - HTTP 请求
 * @param res - HTTP 响应
 */
async function handleInboundRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET") {
    writeJson(res, 200, {
      ok: true,
      channel: "customchat",
      ingressPath: DEFAULT_INGRESS_PATH,
    });
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const parsed = (await readJsonRequest(req)) as InboundRequestPayload | null;
    if (!parsed) {
      writeJson(res, 400, { error: "Invalid payload." });
      return;
    }

    const result = await processInboundPayload(parsed);
    writeJson(res, 200, result);
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat inbound failed.",
    });
  }
}

/**
 * 处理 GET /customchat/agents 请求 — 返回可用 Agent 列表。
 * 需要 Bearer Token 认证。
 */
async function handleAgentsRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const agents = await listAgents();
    writeJson(res, 200, { ok: true, agents });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat agents failed.",
    });
  }
}

/**
 * 处理 GET /customchat/agent-avatar?agentId=xxx 请求 — 返回 Agent 头像图片。
 * 需要 Bearer Token 认证。返回二进制图片数据。
 */
async function handleAgentAvatarRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const requestUrl = new URL(req.url || DEFAULT_AGENT_AVATAR_PATH, "http://customchat.local");
    const requestedAgentId = requestUrl.searchParams.get("agentId")?.trim();
    if (!requestedAgentId) {
      writeJson(res, 400, { error: "agentId is required." });
      return;
    }

    const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    const list = config?.agents?.list || [];
    const defaults = config?.agents?.defaults || {};
    
    const record = list.find((candidate: unknown) => {
      const agent = toAgentView(asJsonRecord(candidate));
      return agent?.id === requestedAgentId;
    });
    if (!record) {
      writeJson(res, 404, { error: "Agent not found." });
      return;
    }

    // Prepare enriched record for findAgentAvatarPath
    const enrichedRecord = {
       ...record,
       workspace: record.workspace || defaults.workspace,
       agentDir: record.agentDir || path.join(os.homedir(), ".openclaw", "agents", requestedAgentId, "agent")
    };

    const avatarPath = await findAgentAvatarPath(enrichedRecord, requestedAgentId);
    if (!avatarPath) {
      writeJson(res, 404, { error: "Avatar not found." });
      return;
    }

    const content = await fs.readFile(avatarPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", guessImageMimeType(avatarPath));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(content);
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat agent avatar failed.",
    });
  }
}

async function handleStatusRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const requestUrl = new URL(req.url || DEFAULT_STATUS_PATH, "http://127.0.0.1");
    const result = await readCustomChatSessionStatus({
      target: requestUrl.searchParams.get("target") || "",
      sessionKey: requestUrl.searchParams.get("sessionKey")?.trim() || null,
      runId: requestUrl.searchParams.get("runId")?.trim() || null,
      agentId: requestUrl.searchParams.get("agentId")?.trim() || null,
    });

    writeJson(res, 200, {
      ok: true,
      ...result,
    });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat status failed.",
    });
  }
}

/**
 * 处理 DELETE /customchat/session 请求 — 删除 Gateway 会话并清除路由绑定。
 * 同时尝试删除标准 5 段 key 和 6 段（含 group:）key。
 * 需要 Bearer Token 认证。
 */
async function handleSessionRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET") {
    const expectedToken = await getInboundToken();
    if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
      writeJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const requestUrl = new URL(req.url || DEFAULT_SESSION_PATH, "http://127.0.0.1");
      const result = await inspectCustomChatSession({
        target: requestUrl.searchParams.get("target") || "",
        sessionKey: requestUrl.searchParams.get("sessionKey")?.trim() || null,
        runId: requestUrl.searchParams.get("runId")?.trim() || null,
        agentId: requestUrl.searchParams.get("agentId")?.trim() || null,
      });

      writeJson(res, 200, {
        ok: true,
        ...result,
      });
      return;
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : "customchat session inspect failed.",
      });
      return;
    }
  }

  if (req.method !== "DELETE") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, DELETE");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const parsed = (await readJsonRequest(req)) as SessionMutationPayload | null;
    if (!parsed) {
      writeJson(res, 400, { error: "Invalid payload." });
      return;
    }

    const target = normalizeChannelTarget(parsed.target || `channel:${parsed.panelId || ""}`);
    if (!target) {
      writeJson(res, 400, { error: "target is required." });
      return;
    }

    const remembered = await findRouteBinding({
      target,
      sessionKey: parsed.sessionKey?.trim() || null,
    });
    const agentId = parsed.agentId?.trim() || remembered?.agentId || "main";
    const key =
      normalizeSessionKeyCandidate(parsed.sessionKey) ||
      normalizeSessionKeyCandidate(remembered?.sessionKey) ||
      normalizeSessionKeyCandidate(remembered?.expectedSessionKey) ||
      buildCanonicalSessionKey(agentId, target);

    // BATCH DELETION:
    // We try to delete both the standard 5-part key and the 6-part gateway-mirrored key.
    const deleteKeys = new Set<string>();
    deleteKeys.add(key);

    // If key doesn't have group:, try adding it
    if (!key.includes(":group:")) {
      deleteKeys.add(key.replace(":customchat:", ":customchat:group:"));
    }
    // If key has group:, try removing it
    if (key.includes(":group:")) {
      deleteKeys.add(key.replace(":group:", ":"));
    }

    // Background the heavy gateway calls
    for (const k of deleteKeys) {
      deleteGatewaySession(k, parsed.deleteTranscript !== false).catch((error) => {
        console.error(`[customchat] background sessions.delete failed for ${k}:`, error);
      });
    }

    await removeRouteBinding({
      target,
      sessionKey: key,
      expectedSessionKey: remembered?.expectedSessionKey || key,
    });

    writeJson(res, 200, {
      ok: true,
      keys: Array.from(deleteKeys),
    });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat session delete failed.",
    });
  }
}

/**
 * 处理 POST /customchat/abort 请求 — 中止正在运行的 Agent 任务。
 * 通过 Gateway RPC 调用 chat.abort，并轮询等待确认。
 * 需要 Bearer Token 认证。
 */
async function handleAbortRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return;
  }

  const expectedToken = await getInboundToken();
  if (!expectedToken || readAuthorizationToken(req) !== expectedToken) {
    writeJson(res, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const parsed = (await readJsonRequest(req)) as SessionMutationPayload | null;
    if (!parsed) {
      writeJson(res, 400, { error: "Invalid payload." });
      return;
    }

    const result = await abortCustomChatSession({
      target: parsed.target || null,
      panelId: parsed.panelId || null,
      sessionKey: parsed.sessionKey?.trim() || null,
      runId: parsed.runId?.trim() || null,
      agentId: parsed.agentId?.trim() || null,
    });
    writeJson(res, 200, {
      ...result,
    });
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : "customchat abort failed.",
    });
  }
}

export function initializeCustomChatRuntime(api: CustomChatHttpRouteApi) {
  markCustomChatServiceBoot();
  // Initialize debug logging early (async, non-blocking)
  void resolvePluginDebug().then((enabled) => {
    if (enabled) console.log("[customchat] debug logging enabled");
  });

  const isCli = !api.registerHttpRoute;

  if (!isCli) {
    globalThis.setTimeout(() => {
      ensureGatewaySubscriber();
    }, GATEWAY_SUBSCRIBER_START_DELAY_MS);
    ensurePortalBridgeLoop();
    // 主动建立到 App bridge 的 WebSocket 连接，确保 App → Plugin 的 inbound/rpc 消息
    // 在第一条用户消息到达时已经可用（不等到第一次 deliver 才懒连接）。
    void resolveDefaultAccountConfig().then((cfg) => ensurePortalSocket(cfg)).catch(() => null);
  } else {
    // Only restore runs if we might need them for CLI commands that query history/status.
    // But don't start the background subscriber loop.
    void restoreTrackedRunsFromRouteState().catch(() => null);
  }

}

export function buildCustomChatPlugin() {
  return {
    id: CUSTOMCHAT_PLUGIN_ID,
    meta: CUSTOMCHAT_CHANNEL_META,
    messaging: {
      normalizeTarget(target: string) {
        return normalizeChannelTarget(target) || target.trim();
      },
      targetResolver: {
        hint: "direct:<channelId>",
        looksLikeId(raw: string, normalized: string | undefined) {
          return Boolean(normalizeChannelTarget(normalized || raw));
        },
      },
    },
    capabilities: {
      chatTypes: ["direct"],
    },
    gateway: {
      async startAccount({ abortSignal }: { abortSignal: AbortSignal }) {
        if (abortSignal.aborted) {
          return;
        }

        // Keep the channel runtime alive so OpenClaw health-monitor does not
        // repeatedly treat customchat as a stopped channel and restart it.
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    },
    config: {
      listAccountIds(cfg: { channels?: { customchat?: unknown } } | undefined) {
        const channelConfig = asJsonRecord(cfg?.channels?.customchat);
        const accountMap =
          channelConfig.accounts &&
            typeof channelConfig.accounts === "object" &&
            !Array.isArray(channelConfig.accounts)
            ? (channelConfig.accounts as Record<string, JsonRecord>)
            : null;

        if (accountMap) {
          const ids = Object.keys(accountMap);
          return ids.length > 0 ? ids : ["default"];
        }

        return ["default"];
      },
      resolveAccount(
        cfg: { channels?: { customchat?: unknown } } | undefined,
        accountId: string | undefined,
      ) {
        const channelConfig = asJsonRecord(cfg?.channels?.customchat);
        return normalizeAccountConfig(channelConfig, accountId || "default");
      },
    },
    outbound: {
      deliveryMode: "direct",
      resolveTarget(input: { to?: string }) {
        const normalized = normalizeChannelTarget(input.to);
        if (!normalized) {
          return {
            ok: false,
            error: new Error(
              `Unknown target "${input.to ?? ""}" for Custom Chat. Hint: channel:<channelId>`,
            ),
          };
        }

        return {
          ok: true,
          to: normalized,
        };
      },
      async sendText(input: unknown, ctx: ChannelContext | undefined) {
        const accountConfig = await resolveDefaultAccountConfig();
        const inputRecord = asJsonRecord(input);
        pluginLog("outbound", "sendText", "← input", {
          ctxRunId: ctx?.runId || "",
          to:
            typeof inputRecord.to === "string"
              ? inputRecord.to
              : "",
          textLen:
            typeof inputRecord.text === "string"
              ? String(inputRecord.text.length)
              : "0",
          inputKeys: Object.keys(inputRecord).join(","),
        });
        return deliverMessage(input, accountConfig, ctx?.runId);
      },
      async sendMedia(input: unknown, ctx: ChannelContext | undefined) {
        const accountConfig = await resolveDefaultAccountConfig();
        const inputRecord = asJsonRecord(input);
        pluginLog("outbound", "sendMedia", "← input", {
          ctxRunId: ctx?.runId || "",
          to:
            typeof inputRecord.to === "string"
              ? inputRecord.to
              : "",
          textLen:
            typeof inputRecord.text === "string"
              ? String(inputRecord.text.length)
              : "0",
          inputKeys: Object.keys(inputRecord).join(","),
        });
        return deliverMessage(input, accountConfig, ctx?.runId);
      },
      async sendMessage(input: unknown, ctx: ChannelContext | undefined) {
        const accountConfig = await resolveDefaultAccountConfig();
        const inputRecord = asJsonRecord(input);
        pluginLog("outbound", "sendMessage", "← input", {
          ctxRunId: ctx?.runId || "",
          to:
            typeof inputRecord.to === "string"
              ? inputRecord.to
              : "",
          textLen:
            typeof inputRecord.text === "string"
              ? String(inputRecord.text.length)
              : "0",
          inputKeys: Object.keys(inputRecord).join(","),
        });
        return deliverMessage(input, accountConfig, ctx?.runId);
      },
    },
  };
}

export function registerCustomChatHttpRoutes(api: CustomChatHttpRouteApi) {
  if (typeof api.registerHttpRoute === "function") {
    api.registerHttpRoute({
      path: DEFAULT_INGRESS_PATH,
      auth: "plugin",
      handler: handleInboundRequest,
    });
    api.registerHttpRoute({
      path: DEFAULT_AGENTS_PATH,
      auth: "plugin",
      handler: handleAgentsRequest,
    });
    api.registerHttpRoute({
      path: DEFAULT_AGENT_AVATAR_PATH,
      auth: "plugin",
      handler: handleAgentAvatarRequest,
    });
    api.registerHttpRoute({
      path: DEFAULT_SESSION_PATH,
      auth: "plugin",
      handler: handleSessionRequest,
    });
    api.registerHttpRoute({
      path: DEFAULT_STATUS_PATH,
      auth: "plugin",
      handler: handleStatusRequest,
    });
    api.registerHttpRoute({
      path: DEFAULT_ABORT_PATH,
      auth: "plugin",
      handler: handleAbortRequest,
    });
  }
}

export function activateLegacyCustomChat(api: CustomChatLegacyActivateApi) {
  initializeCustomChatRuntime(api);
  api.registerChannel({ plugin: buildCustomChatPlugin() });
  registerCustomChatHttpRoutes(api);
}

export default activateLegacyCustomChat;
