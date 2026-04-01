import "server-only";

import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import type { AgentView, ChannelView } from "@/lib/types";

/**
 * Agent 目录加载模块。
 * 支持两种来源：从 Provider（Gateway）远程拉取，或从环境变量 APP_AGENT_CATALOG 本地解析。
 * 远程拉取带缓存（5 分钟 TTL），首次 SSR 使用快速超时以避免阻塞。
 */

const log = createLogger("agents");

const DEFAULT_AGENTS: AgentView[] = [
  {
    id: "main",
    name: "Main",
    emoji: null,
    avatarUrl: null,
    theme: null,
  },
];

const PROVIDER_AGENT_CACHE_TTL_MS = 300_000;
const PROVIDER_AGENT_FETCH_TIMEOUT_MS = 10_000;
const PROVIDER_AGENT_FAST_TIMEOUT_MS = 600;

let providerAgentCache:
  | {
      expiresAt: number;
      agents: AgentView[] | null;
    }
  | null = null;

function isAgentView(value: unknown): value is AgentView {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { name?: unknown }).name === "string",
  );
}

function normalizeAgent(input: AgentView) {
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    emoji: input.emoji?.trim() || null,
    avatarUrl: input.avatarUrl?.trim() || null,
    theme: input.theme?.trim() || null,
  };
}

function parseAgentCatalog(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return DEFAULT_AGENTS;
    }

    const agents = parsed
      .filter(isAgentView)
      .map(normalizeAgent)
      .filter((agent) => agent.id && agent.name);

    return agents.length > 0 ? agents : DEFAULT_AGENTS;
  } catch {
    return DEFAULT_AGENTS;
  }
}

async function fetchProviderAgents(
  forceRefresh = false,
  timeoutMs = PROVIDER_AGENT_FETCH_TIMEOUT_MS
): Promise<AgentView[] | null> {
  const now = Date.now();
  if (!forceRefresh && providerAgentCache && providerAgentCache.expiresAt > now) {
    return providerAgentCache.agents;
  }

  const env = getEnv();
  if (!env.providerBaseUrl || !env.customChatAuthToken) {
    return null;
  }

  const baseUrl = env.providerBaseUrl.replace(/\/+$/, "");
  
  // Internal helper to perform the actual fetch
  const doFetch = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROVIDER_AGENT_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/customchat/agents`, {
        headers: {
          Authorization: `Bearer ${env.customChatAuthToken}`,
        },
        cache: "no-store",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) return null;
      const payload = (await response.json().catch(() => null)) as { agents?: unknown } | null;
      if (!payload?.agents || !Array.isArray(payload.agents)) return null;

      const agents = payload.agents
        .filter(isAgentView)
        .map(normalizeAgent)
        .map((agent) => ({
          ...agent,
          avatarUrl: agent.avatarUrl ? `/api/agents/${encodeURIComponent(agent.id)}/avatar` : null,
        }))
        .filter((agent) => agent.id && agent.name);

      const resolved = agents.length > 0 ? agents : null;
      providerAgentCache = {
        expiresAt: Date.now() + PROVIDER_AGENT_CACHE_TTL_MS,
        agents: resolved,
      };
      log.output("fetchProviderAgents", {
        count: String(resolved?.length ?? 0),
        ids: resolved?.map((a) => a.id).join(",") ?? "none",
      });
      return resolved;
    } catch (e) {
      clearTimeout(timeout);
      log.error("fetchProviderAgents", e);
      return null;
    }
  };

  // If we are in "fast" mode (short timeout), we race the fetch against the short timeout.
  // But we always let the fetch finish in the background to populate the cache even if we time out here.
  if (timeoutMs < PROVIDER_AGENT_FETCH_TIMEOUT_MS) {
    const result = await Promise.race([
      doFetch(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    
    // If we timed out (result is null) and we don't have a cache yet, 
    // the doFetch() is still running in the background and will fill providerAgentCache eventually.
    return result;
  }

  return doFetch();
}

/**
 * 加载 Agent 目录。优先从 Provider 远程获取，失败时回退到本地环境变量配置。
 *
 * @param {boolean} [forceRefresh=false] - 是否强制刷新缓存（UI 手动触发时为 true）
 * @returns {Promise<AgentView[]>} Agent 列表，至少包含一个默认 Agent
 */
export async function loadAgentCatalog(forceRefresh = false) {
  // Use a fast timeout for initial load to prevent blocking SSR
  // If it's a force refresh (triggered from UI), we can wait longer
  const timeout = forceRefresh ? PROVIDER_AGENT_FETCH_TIMEOUT_MS : PROVIDER_AGENT_FAST_TIMEOUT_MS;
  const providerAgents = await fetchProviderAgents(forceRefresh, timeout);
  
  if (providerAgents?.length) {
    return providerAgents;
  }

  const raw = getEnv().agentCatalogJson;
  const catalog = raw ? parseAgentCatalog(raw) : DEFAULT_AGENTS;
  return catalog.map((agent) => ({
    ...agent,
    avatarUrl: agent.avatarUrl ? `/api/agents/${encodeURIComponent(agent.id)}/avatar` : null,
  }));
}

/**
 * 获取频道视图的静态描述。
 * @returns {ChannelView} 频道视图对象
 */
export function getChannelView(): ChannelView {
  return {
    mode: "provider",
    state: "passive",
    label: "Slack-style channel",
    errorMessage: null,
  };
}
