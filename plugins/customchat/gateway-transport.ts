import crypto from "node:crypto";
import { spawn } from "node:child_process";

import {
  type JsonRecord,
  type SessionSnapshot,
  sleep,
  flattenSessionRecords,
  parseJsonOutput,
  scoreSessionSnapshot,
  toSessionSnapshot,
} from "./utils.js";
import { customChatRuntimeStore } from "./runtime-store.js";

const DEFAULT_OPENCLAW_BIN =
  process.env.CUSTOMCHAT_OPENCLAW_BIN?.trim() ||
  process.env.OPENCLAW_BIN?.trim() ||
  "openclaw";
const SESSION_RESOLVE_ATTEMPTS = 6;
const SESSION_RESOLVE_BACKOFF_MS = [200, 350, 600, 900, 1300, 1800];

async function dispatchGatewayRequest(
  method: string,
  params: JsonRecord,
  timeoutMs = 15_000,
): Promise<JsonRecord> {
  const ws = customChatRuntimeStore.activeGatewayWebSocket;
  if (!ws || ws.readyState !== ws.OPEN) {
    throw new Error(`Gateway WebSocket is not connected (method: ${method}).`);
  }

  const id = `rpc:customchat:${crypto.randomUUID()}`;
  return new Promise<JsonRecord>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      customChatRuntimeStore.pendingRpcRequests.delete(id);
      reject(new Error(`Gateway RPC request timed out (method: ${method}, id: ${id})`));
    }, timeoutMs);

    customChatRuntimeStore.pendingRpcRequests.set(id, { resolve, reject, timeout });
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        method,
        params,
      }),
    );
  });
}

async function runOpenClawJson(args: string[]) {
  const child = spawn(DEFAULT_OPENCLAW_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      OPENCLAW_PLUGINS_ALLOW: "",
      OPENCLAW_GATEWAY: "0",
    },
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout?.on("data", (chunk) => {
    stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });

  if (exitCode !== 0) {
    const errorText = Buffer.concat(stderr).toString("utf8").trim();
    throw new Error(errorText || `openclaw ${args.join(" ")} failed with exit ${exitCode}`);
  }

  return parseJsonOutput(Buffer.concat(stdout).toString("utf8"));
}

export async function runGatewayCall(method: string, params: JsonRecord) {
  try {
    return await dispatchGatewayRequest(method, params);
  } catch {
    return runOpenClawJson([
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
    ]);
  }
}

export async function listGatewaySessions(): Promise<SessionSnapshot[]> {
  let payload: unknown = null;

  try {
    payload = await runGatewayCall("sessions.list", {});
  } catch {
    payload = await runOpenClawJson(["sessions", "--json"]);
  }

  const seenKeys = new Set<string>();
  const snapshots: SessionSnapshot[] = [];
  for (const record of flattenSessionRecords(payload)) {
    const snapshot = toSessionSnapshot(record);
    if (!snapshot || seenKeys.has(snapshot.key)) {
      continue;
    }
    seenKeys.add(snapshot.key);
    snapshots.push(snapshot);
  }
  return snapshots;
}

export async function waitForGatewayRun(runId: string, timeoutMs = 0) {
  return runGatewayCall("agent.wait", { runId, timeoutMs });
}

export async function fetchGatewayChatHistory(sessionKey: string, limit = 100) {
  return runGatewayCall("chat.history", { sessionKey, limit });
}

export async function abortGatewaySession(sessionKey: string) {
  return runGatewayCall("chat.abort", { sessionKey });
}

export async function deleteGatewaySession(key: string, deleteTranscript: boolean) {
  return runGatewayCall("sessions.delete", { key, deleteTranscript });
}

export async function sendGatewayChatTurn(input: {
  sessionKey: string;
  idempotencyKey: string;
  message: string;
}) {
  return runGatewayCall("chat.send", {
    sessionKey: input.sessionKey,
    idempotencyKey: input.idempotencyKey,
    message: input.message,
    deliver: false,
  });
}

export async function resolveActualSessionKey(input: {
  agentId: string;
  target: string;
  expectedSessionKey: string;
  startedAtMs: number;
}) {
  for (let attempt = 0; attempt < SESSION_RESOLVE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(
        SESSION_RESOLVE_BACKOFF_MS[
          Math.min(attempt - 1, SESSION_RESOLVE_BACKOFF_MS.length - 1)
        ] as number,
      );
    }

    try {
      const sessions = await listGatewaySessions();
      let bestMatch: { key: string; score: number } | null = null;

      for (const snapshot of sessions) {
        const score = scoreSessionSnapshot(snapshot, input);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { key: snapshot.key, score };
        }
      }

      if (bestMatch && bestMatch.score >= 90) {
        return bestMatch.key;
      }
    } catch {
      continue;
    }
  }

  return null;
}
