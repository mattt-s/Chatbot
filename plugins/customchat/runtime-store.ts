import type { PortalDeliveryState } from "./utils.js";
import type {
  CustomChatRuntimeInspection,
  CustomChatRuntimeStatus,
  PendingRpcRequest,
  TrackedRun,
} from "./runtime-types.js";

export const customChatRuntimeStore = {
  trackedRuns: new Map<string, TrackedRun>(),
  gatewaySubscriberLoopStarted: false,
  gatewayRecoveryTimer: null as ReturnType<typeof globalThis.setInterval> | null,
  activeGatewayWebSocket: null as WebSocket | null,
  pendingRpcRequests: new Map<string, PendingRpcRequest>(),
  serviceBootstrapped: false,
  serviceBootCount: 0,
  lastServiceBootAtMs: 0,
  lastSubscriberConnectAtMs: 0,
  lastSubscriberErrorAtMs: 0,
  lastSubscriberErrorMessage: null as string | null,
};

export function markCustomChatServiceBoot() {
  customChatRuntimeStore.serviceBootstrapped = true;
  customChatRuntimeStore.serviceBootCount += 1;
  customChatRuntimeStore.lastServiceBootAtMs = Date.now();
}

export function markGatewaySubscriberLoopStarted() {
  customChatRuntimeStore.gatewaySubscriberLoopStarted = true;
}

export function setGatewayRecoveryTimer(timer: ReturnType<typeof globalThis.setInterval> | null) {
  customChatRuntimeStore.gatewayRecoveryTimer = timer;
}

export function isGatewaySocketConnected() {
  const socket = customChatRuntimeStore.activeGatewayWebSocket;
  return Boolean(socket && socket.readyState === socket.OPEN);
}

export function recordGatewaySubscriberConnected() {
  customChatRuntimeStore.lastSubscriberConnectAtMs = Date.now();
  customChatRuntimeStore.lastSubscriberErrorMessage = null;
}

export function recordGatewaySubscriberError(error: unknown) {
  customChatRuntimeStore.lastSubscriberErrorAtMs = Date.now();
  customChatRuntimeStore.lastSubscriberErrorMessage =
    error instanceof Error ? error.message : String(error);
}

export function findTrackedRunCandidate(input: {
  runId?: string | null;
  target?: string | null;
  sessionKey?: string | null;
}) {
  const runId = input.runId?.trim() || null;
  if (runId) {
    const direct = customChatRuntimeStore.trackedRuns.get(runId);
    if (direct) {
      return direct;
    }
  }

  const target = input.target?.trim() || null;
  const sessionKey = input.sessionKey?.trim() || null;
  if (!target && !sessionKey) {
    return null;
  }

  for (const trackedRun of customChatRuntimeStore.trackedRuns.values()) {
    if (sessionKey && trackedRun.sessionKey === sessionKey) {
      return trackedRun;
    }
    if (target && trackedRun.target === target) {
      return trackedRun;
    }
  }

  return null;
}

function isTerminalRuntimeState(state: PortalDeliveryState | null) {
  return state === "final" || state === "aborted" || state === "error";
}

export function buildCustomChatRuntimeInspection(trackedRun: TrackedRun | null): CustomChatRuntimeInspection {
  return {
    tracked: Boolean(trackedRun),
    runId: trackedRun?.runId || null,
    terminalState: trackedRun?.terminalState || null,
    target: trackedRun?.target || null,
    sessionKey: trackedRun?.sessionKey || null,
    websocketConnected: isGatewaySocketConnected(),
    trackedRunCount: customChatRuntimeStore.trackedRuns.size,
  };
}

export function hasRuntimeTerminalState(trackedRun: TrackedRun | null) {
  return isTerminalRuntimeState(trackedRun?.terminalState || null);
}

export function getCustomChatRuntimeStatusSummary(): CustomChatRuntimeStatus {
  return {
    serviceBootstrapped: customChatRuntimeStore.serviceBootstrapped,
    serviceBootCount: customChatRuntimeStore.serviceBootCount,
    lastServiceBootAtMs: customChatRuntimeStore.lastServiceBootAtMs || null,
    gatewaySubscriberLoopStarted: customChatRuntimeStore.gatewaySubscriberLoopStarted,
    gatewayRecoveryLoopStarted: Boolean(customChatRuntimeStore.gatewayRecoveryTimer),
    websocketConnected: isGatewaySocketConnected(),
    trackedRunCount: customChatRuntimeStore.trackedRuns.size,
    pendingRpcRequestCount: customChatRuntimeStore.pendingRpcRequests.size,
    lastSubscriberConnectAtMs: customChatRuntimeStore.lastSubscriberConnectAtMs || null,
    lastSubscriberErrorAtMs: customChatRuntimeStore.lastSubscriberErrorAtMs || null,
    lastSubscriberErrorMessage: customChatRuntimeStore.lastSubscriberErrorMessage,
  };
}

