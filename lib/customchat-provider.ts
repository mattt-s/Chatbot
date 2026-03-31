/**
 * customchat Provider 客户端模块
 *
 * 封装对 OpenClaw Gateway customchat 端点的 HTTP 调用，
 * 提供会话删除和运行中止等操作。
 */
import "server-only";

import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const log = createLogger("provider");

/**
 * 构建 Provider 的基础 URL（去除尾部斜杠）
 * @returns {string} Provider 基础 URL
 * @throws {Error} 未配置 CUSTOMCHAT_PROVIDER_BASE_URL 时抛出
 */
function buildProviderBaseUrl() {
  const env = getEnv();
  if (!env.providerBaseUrl) {
    throw new Error("CUSTOMCHAT_PROVIDER_BASE_URL is not configured.");
  }

  return env.providerBaseUrl.replace(/\/+$/, "");
}

/**
 * 读取 Provider 认证令牌
 * @returns {string} Bearer 令牌
 * @throws {Error} 未配置 CUSTOMCHAT_PROVIDER_TOKEN 时抛出
 */
function readProviderToken() {
  const env = getEnv();
  if (!env.providerToken) {
    throw new Error("CUSTOMCHAT_PROVIDER_TOKEN is not configured.");
  }

  return env.providerToken;
}

/**
 * 安全读取 Provider 响应体 JSON
 * @param {Response} response - fetch 响应对象
 * @returns {Promise<T | null>} 解析后的 JSON 或解析失败时返回 null
 */
async function readProviderPayload<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

/**
 * 删除 Provider 端的会话
 * @param {object} input - 删除参数
 * @param {string} input.panelId - 面板 ID
 * @param {string} input.agentId - Agent ID
 * @returns {Promise<{error?: string; ok?: boolean} | null>} Provider 响应
 * @throws {Error} 请求失败时抛出
 */
export async function deleteProviderSession(input: {
  panelId: string;
  agentId: string;
  /** 自定义 target（群组角色用 group:direct:panelId:role:roleId），不传则默认 channel:panelId */
  target?: string;
}) {
  const effectiveTarget = input.target || `channel:${input.panelId}`;
  log.input("deleteProviderSession", { panelId: input.panelId, agentId: input.agentId, target: effectiveTarget });
  const response = await fetch(`${buildProviderBaseUrl()}/customchat/session`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${readProviderToken()}`,
    },
    body: JSON.stringify({
      panelId: input.panelId,
      agentId: input.agentId,
      target: effectiveTarget,
    }),
    cache: "no-store",
  });

  const payload = await readProviderPayload<{ error?: string; ok?: boolean }>(response);
  if (!response.ok) {
    log.error("deleteProviderSession", new Error(payload?.error ?? "session delete failed"), {
      panelId: input.panelId,
      status: String(response.status),
    });
    throw new Error(payload?.error ?? "customchat provider session delete failed.");
  }

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

  const query = new URLSearchParams();
  query.set("panelId", input.panelId);
  query.set("agentId", input.agentId);
  query.set("target", effectiveTarget);
  if (input.runId?.trim()) {
    query.set("runId", input.runId.trim());
  }
  if (input.sessionKey?.trim()) {
    query.set("sessionKey", input.sessionKey.trim());
  }

  const response = await fetch(`${buildProviderBaseUrl()}/customchat/session?${query.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${readProviderToken()}`,
    },
    cache: "no-store",
  });

  const payload = await readProviderPayload<{
    error?: string;
    ok?: boolean;
    exists?: boolean;
    terminal?: boolean;
    waitStatus?: string | null;
    sessionKey?: string | null;
    snapshot?: unknown;
  }>(response);

  if (!response.ok) {
    log.error("inspectProviderSession", new Error(payload?.error ?? "session inspect failed"), {
      panelId: input.panelId,
      status: String(response.status),
    });
    throw new Error(payload?.error ?? "customchat provider session inspect failed.");
  }

  log.output("inspectProviderSession", {
    panelId: input.panelId,
    exists: String(payload?.exists),
    terminal: String(payload?.terminal),
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
 * @returns {Promise<{error?: string; ok?: boolean; verified?: boolean; session?: unknown} | null>} Provider 响应
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
  const response = await fetch(`${buildProviderBaseUrl()}/customchat/abort`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${readProviderToken()}`,
    },
    body: JSON.stringify({
      panelId: input.panelId,
      agentId: input.agentId,
      target: input.target || `channel:${input.panelId}`,
      runId: input.runId?.trim() || undefined,
      sessionKey: input.sessionKey?.trim() || undefined,
    }),
    cache: "no-store",
  });

  const payload = await readProviderPayload<{
    error?: string;
    ok?: boolean;
    verified?: boolean;
    session?: unknown;
  }>(response);
  if (!response.ok) {
    log.error("abortProviderRun", new Error(payload?.error ?? "abort failed"), {
      panelId: input.panelId,
      status: String(response.status),
    });
    throw new Error(payload?.error ?? "customchat provider abort failed.");
  }

  log.output("abortProviderRun", { panelId: input.panelId, ok: "true", verified: String(payload?.verified) });
  return payload;
}
