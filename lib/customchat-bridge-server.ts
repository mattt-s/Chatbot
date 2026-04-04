/**
 * customchat WebSocket Bridge 服务端
 *
 * 在 App 侧启动 WebSocket 服务，接受来自 customchat 插件的连接。
 * 双向通信：
 * - Plugin → App：deliver（消息投递）、app_rpc（管理类 RPC）
 * - App → Plugin：inbound（用户消息发送）
 * 支持心跳检测、token 鉴权、hello/ping/deliver/app_rpc/inbound 协议。
 */
import "server-only";

import crypto from "node:crypto";

import type { WebSocket, WebSocketServer } from "ws";

import { dispatchCustomChatAppRpc } from "@/lib/customchat-app-rpc";
import { getEnv } from "@/lib/env";
import { ingestCustomChatDelivery } from "@/lib/customchat-ingest";
import { createLogger } from "@/lib/logger";

const log = createLogger("bridge");

type BridgeEnvelope =
  | {
      type: "hello";
      role?: string;
      protocol?: number;
    }
  | {
      type: "ping";
      ts?: number;
    }
  | {
      type: "deliver";
      requestId: string;
      payload: unknown;
    }
  | {
      type: "app_rpc";
      requestId: string;
      payload: {
        method?: string;
        params?: Record<string, unknown>;
      };
    }
  | {
      type: "ack";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    };

declare global {
  var __chatbotCustomChatBridgeServerStarted: Promise<void> | undefined;
}

const CUSTOMCHAT_BRIDGE_HOST = "127.0.0.1";
const CUSTOMCHAT_BRIDGE_PATH = "/api/customchat/socket";
const INBOUND_ACK_TIMEOUT_MS = 30_000;

// ── Plugin socket tracking ──────────────────────────────────────────

let pluginSocket: WebSocket | null = null;

type PendingAck = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingAcks = new Map<string, PendingAck>();

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * 读取 Bridge 服务的监听配置（host、port、path）
 * @returns {{ host: string; port: number; path: string }} 监听配置
 */
function getBridgeConfig() {
  const env = getEnv();
  return {
    host: CUSTOMCHAT_BRIDGE_HOST,
    port: env.customChatBridgePort,
    path: CUSTOMCHAT_BRIDGE_PATH,
  };
}

/**
 * 向 WebSocket 连接发送 JSON 消息（仅在连接 OPEN 时发送）
 * @param {WebSocket} socket - 目标 WebSocket 连接
 * @param {Record<string, unknown>} payload - 要发送的 JSON 数据
 */
function sendJson(socket: WebSocket, payload: Record<string, unknown>) {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

/**
 * 检查连接请求是否未通过 token 鉴权
 * @param {URL} requestUrl - 连接请求 URL（含 ?token= 参数）
 * @returns {boolean} true 表示鉴权失败
 */
function isUnauthorized(requestUrl: URL) {
  const expectedAuthToken = getEnv().customChatAuthToken;
  if (!expectedAuthToken) {
    return true;
  }

  const token = requestUrl.searchParams.get("token")?.trim() || "";
  return token !== expectedAuthToken;
}

/**
 * 为 WebSocket 连接绑定心跳存活追踪
 * @param {WebSocket} socket - 目标连接
 */
function bindSocketLifecycle(socket: WebSocket) {
  const trackedSocket = socket as WebSocket & { isAlive?: boolean };
  trackedSocket.isAlive = true;
  socket.on("pong", () => {
    trackedSocket.isAlive = true;
  });
}

/**
 * 启动定时心跳检测，每 15 秒 ping 所有客户端，断开无响应连接
 * @param {WebSocketServer} server - WebSocket 服务实例
 * @returns {NodeJS.Timeout} 定时器句柄
 */
function startHeartbeat(server: WebSocketServer) {
  return setInterval(() => {
    for (const socket of server.clients) {
      const trackedSocket = socket as WebSocket & { isAlive?: boolean };
      if (trackedSocket.isAlive === false) {
        socket.terminate();
        continue;
      }

      trackedSocket.isAlive = false;
      socket.ping();
    }
  }, 15_000);
}

/**
 * 清理 plugin socket 引用及所有 pending ack
 */
function clearPluginSocket() {
  pluginSocket = null;
  for (const [requestId, pending] of pendingAcks) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Plugin WebSocket disconnected."));
    pendingAcks.delete(requestId);
  }
}

// ── Envelope handler ────────────────────────────────────────────────

/**
 * 处理收到的桥接协议信封：hello（握手）、ping（保活）、deliver（消息投递）、app_rpc（管理调用）、ack（inbound/rpc 回复）
 * @param {WebSocket} socket - 来源连接
 * @param {BridgeEnvelope} envelope - 解析后的协议信封
 */
async function handleEnvelope(socket: WebSocket, envelope: BridgeEnvelope) {
  if (envelope.type === "hello") {
    sendJson(socket, {
      type: "hello",
      role: "app",
      protocol: 1,
    });
    return;
  }

  if (envelope.type === "ping") {
    sendJson(socket, {
      type: "pong",
      ts: envelope.ts ?? Date.now(),
    });
    return;
  }

  if (envelope.type === "ack") {
    const pending = pendingAcks.get(envelope.requestId);
    if (!pending) {
      return;
    }
    pendingAcks.delete(envelope.requestId);
    clearTimeout(pending.timer);
    if (envelope.ok) {
      pending.resolve(envelope.result ?? {});
    } else {
      pending.reject(new Error(envelope.error || "Plugin rejected request."));
    }
    return;
  }

  if (envelope.type === "deliver") {
    try {
      log.input("handleEnvelope", { type: "deliver", requestId: envelope.requestId });
      const result = await ingestCustomChatDelivery(envelope.payload);
      log.output("handleEnvelope", { requestId: envelope.requestId, ok: "true" });
      sendJson(socket, {
        type: "ack",
        requestId: envelope.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      log.error("handleEnvelope", error, { requestId: envelope.requestId });
      sendJson(socket, {
        type: "ack",
        requestId: envelope.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "Bridge delivery failed.",
      });
    }
    return;
  }

  if (envelope.type === "app_rpc") {
    const method = envelope.payload?.method?.trim() || "";
    const params = (envelope.payload?.params &&
    typeof envelope.payload.params === "object"
      ? envelope.payload.params
      : {}) as Record<string, unknown>;

    try {
      if (!method) {
        throw new Error("App RPC method is required.");
      }
      log.input("handleEnvelope", {
        type: "app_rpc",
        requestId: envelope.requestId,
        method,
      });
      const result = await dispatchCustomChatAppRpc(method, params);
      sendJson(socket, {
        type: "ack",
        requestId: envelope.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      log.error("handleEnvelope", error, {
        requestId: envelope.requestId,
        method,
      });
      sendJson(socket, {
        type: "ack",
        requestId: envelope.requestId,
        ok: false,
        error: error instanceof Error ? error.message : "App RPC failed.",
      });
    }
    return;
  }

  log.debug("handleEnvelope", { type: (envelope as { type: string }).type, result: "unsupported" });
  sendJson(socket, {
    type: "error",
    error: "Unsupported bridge message.",
  });
}

// ── Server startup ──────────────────────────────────────────────────

/**
 * 启动 WebSocket Bridge 服务，监听配置端口并处理插件连接
 * @throws {Error} 端口被占用以外的启动错误
 */
async function startCustomChatBridgeServer() {
  process.env.WS_NO_BUFFER_UTIL ??= "1";
  process.env.WS_NO_UTF_8_VALIDATE ??= "1";
  const { WebSocketServer } = await import("ws");
  const config = getBridgeConfig();
  const server: WebSocketServer = new WebSocketServer({
    host: config.host,
    port: config.port,
    path: config.path,
  });
  const heartbeat = startHeartbeat(server);

  server.on("connection", (socket, request) => {
    const requestUrl = new URL(
      request.url || config.path,
      `http://${request.headers.host || `${config.host}:${config.port}`}`,
    );

    if (isUnauthorized(requestUrl)) {
      log.debug("connection", { result: "unauthorized", url: requestUrl.toString() });
      socket.close(1008, "Unauthorized");
      return;
    }

    log.debug("connection", { result: "accepted" });
    bindSocketLifecycle(socket);

    // 追踪 plugin socket（新连接取代旧连接）
    if (pluginSocket && pluginSocket !== socket) {
      clearPluginSocket();
    }
    pluginSocket = socket;

    socket.on("close", () => {
      if (pluginSocket === socket) {
        clearPluginSocket();
      }
    });

    sendJson(socket, {
      type: "hello",
      role: "app",
      protocol: 1,
    });

    socket.on("message", (message) => {
      const raw = Buffer.isBuffer(message) ? message.toString("utf8") : String(message);
      let envelope: BridgeEnvelope;
      try {
        envelope = JSON.parse(raw) as BridgeEnvelope;
      } catch {
        sendJson(socket, {
          type: "error",
          error: "Invalid bridge payload.",
        });
        return;
      }

      void handleEnvelope(socket, envelope);
    });
  });

  server.on("close", () => {
    clearInterval(heartbeat);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  }).catch((error) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code !== "EADDRINUSE") {
      throw error;
    }
  });
}

/**
 * 确保 Bridge 服务已启动（单例模式，全局只启动一次）
 * @returns {Promise<void>} 服务就绪的 Promise
 */
export function ensureCustomChatBridgeServer() {
  if (!globalThis.__chatbotCustomChatBridgeServerStarted) {
    globalThis.__chatbotCustomChatBridgeServerStarted = startCustomChatBridgeServer().catch(
      (error) => {
        globalThis.__chatbotCustomChatBridgeServerStarted = undefined;
        throw error;
      },
    );
  }

  return globalThis.__chatbotCustomChatBridgeServerStarted;
}

// ── Public API: App → Plugin ─────────────────────────────────────────

/**
 * 向 Plugin 发送 WS 消息并等待 ack 返回结果（通用底层方法）
 */
async function sendToPlugin(
  msgType: string,
  payload: unknown,
  label: string,
): Promise<unknown> {
  await ensureCustomChatBridgeServer();

  if (!pluginSocket || pluginSocket.readyState !== pluginSocket.OPEN) {
    throw new Error("Plugin WebSocket is not connected.");
  }

  const requestId = `${msgType}:${crypto.randomUUID()}`;

  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(requestId);
      reject(new Error(`Plugin ${label} ack timed out.`));
    }, INBOUND_ACK_TIMEOUT_MS);

    pendingAcks.set(requestId, { resolve, reject, timer });

    log.input(label, { requestId });

    sendJson(pluginSocket!, {
      type: msgType,
      requestId,
      payload,
    });
  });
}

export type InboundPayload = {
  panelId?: string;
  agentId?: string;
  target: string;
  messageId: string;
  text: string;
  attachments?: unknown[];
};

/**
 * 通过 WebSocket 向 Plugin 发送 inbound 用户消息
 */
export async function sendInboundToPlugin(
  payload: InboundPayload,
): Promise<{ runId: string; status: string }> {
  const result = await sendToPlugin("inbound", payload, "sendInboundToPlugin") as Record<string, unknown>;
  return {
    runId: (typeof result?.runId === "string" && result.runId.trim()) || "",
    status: (typeof result?.status === "string" && result.status.trim()) || "started",
  };
}

/**
 * 通过 WebSocket 向 Plugin 发送 RPC 调用（管理类 API）
 */
export async function sendRpcToPlugin<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return sendToPlugin("rpc", { method, params: params ?? {} }, `rpc:${method}`) as Promise<T>;
}

/**
 * 检查 Plugin WebSocket 是否已连接
 */
export function isPluginConnected(): boolean {
  return pluginSocket !== null && pluginSocket.readyState === pluginSocket.OPEN;
}
