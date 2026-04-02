/**
 * customchat Provider 客户端模块
 *
 * 通过 WebSocket RPC 调用 Plugin 端的管理类 API，
 * 提供会话检查、状态查询、会话删除和运行中止等操作。
 */
import "server-only";

import { ensureCustomChatBridgeServer, sendRpcToPlugin } from "@/lib/customchat-bridge-server";
import { createLogger } from "@/lib/logger";

const log = createLogger("provider");

/**
 * 删除 Provider 端的会话
 * @param {object} input - 删除参数
 * @param {string} input.panelId - 面板 ID
 * @param {string} input.agentId - Agent ID
 * @param {string} [input.target] - 自定义 target
 * @returns {Promise<{ok?: boolean; keys?: string[]} | null>} Provider 响应
 * @throws {Error} 请求失败时抛出
 */
export async function deleteProviderSession(input: {
  panelId: string;
  agentId: string;
  target?: string;
}) {
  const effectiveTarget = input.target || `channel:${input.panelId}`;
  log.input("deleteProviderSession", { panelId: input.panelId, agentId: input.agentId, target: effectiveTarget });

  await ensureCustomChatBridgeServer();
  const payload = await sendRpcToPlugin<{ ok?: boolean; keys?: string[]; error?: string }>(
    "session.delete",
    {
      panelId: input.panelId,
      agentId: input.agentId,
      target: effectiveTarget,
    },
  );

  log.output("deleteProviderSession", { panelId: input.panelId, ok: "true" });
  return payload;
}

export async function inspectProviderSession(input: {
  panelId: string;
  agentId: string;
  runId?: string | null;
  sessionKey?: string | null;
  target?: string;
}) {
  const effectiveTarget = input.target || `channel:${input.panelId}`;
  log.input("inspectProviderSession", {
    panelId: input.panelId,
    agentId: input.agentId,
    target: effectiveTarget,
    runId: input.runId ?? "null",
  });

  await ensureCustomChatBridgeServer();
  const payload = await sendRpcToPlugin<{
    ok?: boolean;
    exists?: boolean;
    terminal?: boolean;
    waitStatus?: string | null;
    sessionKey?: string | null;
    snapshot?: unknown;
    source?: "runtime" | "gateway-fallback";
  }>("session.inspect", {
    panelId: input.panelId,
    agentId: input.agentId,
    target: effectiveTarget,
    runId: input.runId?.trim() || undefined,
    sessionKey: input.sessionKey?.trim() || undefined,
  });

  log.output("inspectProviderSession", {
    panelId: input.panelId,
    exists: String(payload?.exists),
    terminal: String(payload?.terminal),
  });
  return payload;
}

export async function readProviderSessionStatus(input: {
  panelId: string;
  agentId: string;
  runId?: string | null;
  sessionKey?: string | null;
  target?: string;
}) {
  const effectiveTarget = input.target || `channel:${input.panelId}`;
  log.input("readProviderSessionStatus", {
    panelId: input.panelId,
    agentId: input.agentId,
    target: effectiveTarget,
    runId: input.runId ?? "null",
  });

  await ensureCustomChatBridgeServer();
  const payload = await sendRpcToPlugin<{
    ok?: boolean;
    exists?: boolean;
    sessionKey?: string | null;
    statusText?: string | null;
    source?: "session-store" | "gateway-fallback";
  }>("session.status", {
    panelId: input.panelId,
    agentId: input.agentId,
    target: effectiveTarget,
    runId: input.runId?.trim() || undefined,
    sessionKey: input.sessionKey?.trim() || undefined,
  });

  log.output("readProviderSessionStatus", {
    panelId: input.panelId,
    exists: String(payload?.exists),
    source: payload?.source ?? "unknown",
  });
  return payload;
}

/**
 * 中止 Provider 端正在运行的 Agent run
 * @param {object} input - 中止参数
 * @param {string} input.panelId - 面板 ID
 * @param {string} input.agentId - Agent ID
 * @param {string | null} [input.runId] - 要中止的 runId（可选）
 * @param {string | null} [input.sessionKey] - 会话 key（可选）
 * @returns {Promise<{ok?: boolean; verified?: boolean; session?: unknown} | null>} Provider 响应
 * @throws {Error} 请求失败时抛出
 */
export async function abortProviderRun(input: {
  panelId: string;
  agentId: string;
  runId?: string | null;
  sessionKey?: string | null;
  target?: string;
}) {
  log.input("abortProviderRun", { panelId: input.panelId, agentId: input.agentId, runId: input.runId ?? "null" });

  await ensureCustomChatBridgeServer();
  const payload = await sendRpcToPlugin<{
    ok?: boolean;
    verified?: boolean;
    session?: unknown;
  }>("session.abort", {
    panelId: input.panelId,
    agentId: input.agentId,
    target: input.target || `channel:${input.panelId}`,
    runId: input.runId?.trim() || undefined,
    sessionKey: input.sessionKey?.trim() || undefined,
  });

  log.output("abortProviderRun", { panelId: input.panelId, ok: "true", verified: String(payload?.verified) });
  return payload;
}
