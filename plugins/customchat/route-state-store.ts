import path from "node:path";

import { dedupeStrings, normalizeChannelTarget, parseTimestampMs } from "./utils.js";
import {
  CUSTOMCHAT_STORAGE_ROOT,
  readCustomChatJsonFile,
  writeCustomChatJsonFile,
} from "./storage.js";

export type RouteBinding = {
  target: string;
  agentId: string;
  sessionKey: string | null;
  expectedSessionKey: string | null;
  runIds: string[];
  messageIds: string[];
  createdAt: string;
  updatedAt: string;
};

type RouteState = {
  bindings: RouteBinding[];
};

const ROUTE_STATE_PATH = path.join(CUSTOMCHAT_STORAGE_ROOT, "route-state.json");
const MAX_ROUTE_BINDINGS = 512;
const ROUTE_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function readRouteState() {
  const state = await readCustomChatJsonFile<RouteState>(ROUTE_STATE_PATH, { bindings: [] });
  const now = Date.now();
  return {
    bindings: (Array.isArray(state.bindings) ? state.bindings : [])
      .filter((binding) => binding && typeof binding === "object")
      .map((binding) => ({
        target: typeof binding.target === "string" ? binding.target : "",
        agentId: typeof binding.agentId === "string" ? binding.agentId : "main",
        sessionKey:
          typeof binding.sessionKey === "string" && binding.sessionKey.trim()
            ? binding.sessionKey.trim()
            : null,
        expectedSessionKey:
          typeof binding.expectedSessionKey === "string" && binding.expectedSessionKey.trim()
            ? binding.expectedSessionKey.trim()
            : null,
        runIds: Array.isArray(binding.runIds)
          ? dedupeStrings(binding.runIds as string[])
          : [],
        messageIds: Array.isArray(binding.messageIds)
          ? dedupeStrings(binding.messageIds as string[])
          : [],
        createdAt:
          typeof binding.createdAt === "string" && binding.createdAt.trim()
            ? binding.createdAt
            : new Date(now).toISOString(),
        updatedAt:
          typeof binding.updatedAt === "string" && binding.updatedAt.trim()
            ? binding.updatedAt
            : new Date(now).toISOString(),
      }))
      .filter((binding) => binding.target && now - parseTimestampMs(binding.updatedAt) < ROUTE_STATE_TTL_MS)
      .sort((left, right) => parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt))
      .slice(0, MAX_ROUTE_BINDINGS),
  };
}

async function writeRouteState(state: RouteState) {
  await writeCustomChatJsonFile(ROUTE_STATE_PATH, {
    bindings: state.bindings
      .sort((left, right) => parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt))
      .slice(0, MAX_ROUTE_BINDINGS),
  });
}

export async function rememberRouteBinding(input: {
  target: string;
  agentId: string;
  runId?: string | null;
  messageId?: string | null;
  sessionKey?: string | null;
  expectedSessionKey?: string | null;
}) {
  const state = await readRouteState();
  const nowIso = new Date().toISOString();
  const runId = input.runId?.trim() || null;
  const messageId = input.messageId?.trim() || null;
  const sessionKey = input.sessionKey?.trim() || null;
  const expectedSessionKey = input.expectedSessionKey?.trim() || null;

  const existingIndex = state.bindings.findIndex((binding) => {
    if (runId && binding.runIds.includes(runId)) {
      return true;
    }
    if (messageId && binding.messageIds.includes(messageId)) {
      return true;
    }
    if (sessionKey && binding.sessionKey === sessionKey) {
      return true;
    }
    return binding.target === input.target;
  });

  const existing = existingIndex >= 0 ? state.bindings[existingIndex] : null;
  const nextBinding: RouteBinding = {
    target: input.target,
    agentId: input.agentId,
    sessionKey: sessionKey || existing?.sessionKey || null,
    expectedSessionKey: expectedSessionKey || existing?.expectedSessionKey || null,
    runIds: dedupeStrings([runId, ...(existing?.runIds || [])]),
    messageIds: dedupeStrings([messageId, ...(existing?.messageIds || [])]),
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
  };

  if (existingIndex >= 0) {
    state.bindings.splice(existingIndex, 1, nextBinding);
  } else {
    state.bindings.unshift(nextBinding);
  }

  await writeRouteState(state);
  return nextBinding;
}

export async function removeRouteBinding(input: {
  target?: string | null;
  runId?: string | null;
  sessionKey?: string | null;
  expectedSessionKey?: string | null;
}) {
  const state = await readRouteState();
  const target = normalizeChannelTarget(input.target || "") || null;
  const runId = input.runId?.trim() || null;
  const sessionKey = input.sessionKey?.trim() || null;
  const expectedSessionKey = input.expectedSessionKey?.trim() || null;

  state.bindings = state.bindings.filter((binding) => {
    if (target && binding.target === target) {
      return false;
    }
    if (runId && binding.runIds.includes(runId)) {
      return false;
    }
    if (sessionKey && binding.sessionKey === sessionKey) {
      return false;
    }
    if (expectedSessionKey && binding.expectedSessionKey === expectedSessionKey) {
      return false;
    }
    return true;
  });

  await writeRouteState(state);
}

export async function findRouteBinding(input: {
  runId?: string | null;
  target?: string | null;
  sessionKey?: string | null;
}) {
  const state = await readRouteState();
  const runId = input.runId?.trim() || null;
  const target = normalizeChannelTarget(input.target || "") || null;
  const sessionKey = input.sessionKey?.trim() || null;

  if (runId) {
    const matched = state.bindings.find((binding) => binding.runIds.includes(runId));
    if (matched) {
      return matched;
    }
  }

  if (target) {
    const matched = state.bindings.find((binding) => binding.target === target);
    if (matched) {
      return matched;
    }
  }

  if (sessionKey) {
    const normalizedSessionTarget = normalizeChannelTarget(sessionKey);
    if (normalizedSessionTarget) {
      const matched = state.bindings.find((binding) => binding.target === normalizedSessionTarget);
      if (matched) {
        return matched;
      }
    }

    const matched = state.bindings.find(
      (binding) =>
        binding.sessionKey === sessionKey || binding.expectedSessionKey === sessionKey,
    );
    if (matched) {
      return matched;
    }
  }

  return null;
}
