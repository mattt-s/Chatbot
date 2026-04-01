import type { JsonRecord, PortalDeliveryState, SessionSnapshot } from "./utils.js";

export type CustomChatControlParams = {
  panelId?: string | null;
  target?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  agentId?: string | null;
};

export type TrackedRun = {
  runId: string;
  agentId: string;
  target: string;
  sessionKey: string;
  expectedSessionKey: string | null;
  createdAtMs: number;
  lastEventAtMs: number;
  lastRecoveryAtMs: number;
  latestAssistantText: string;
  latestDeltaText: string;
  sequence: number;
  terminalState: PortalDeliveryState | null;
  toolCallCount: number;
  toolCallArgs: Map<string, JsonRecord>;
  pendingDeltaTimer: ReturnType<typeof globalThis.setTimeout> | null;
  lastHistoryFingerprint: string;
  stableHistoryPasses: number;
  lastHistoryErrorMessage: string | null;
  lastHistoryStopReason: string | null;
  forgetTimer: ReturnType<typeof globalThis.setTimeout> | null;
};

export type PendingRpcRequest = {
  resolve: (value: JsonRecord) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof globalThis.setTimeout>;
};

export type CustomChatRuntimeInspection = {
  tracked: boolean;
  runId: string | null;
  terminalState: PortalDeliveryState | null;
  target: string | null;
  sessionKey: string | null;
  websocketConnected: boolean;
  trackedRunCount: number;
};

export type CustomChatSessionInspection = {
  target: string | null;
  sessionKey: string | null;
  exists: boolean;
  terminal: boolean;
  waitStatus: string | null;
  snapshot: SessionSnapshot | null;
  runtime: CustomChatRuntimeInspection;
  source: "runtime" | "gateway-fallback";
};

export type CustomChatSessionStatus = {
  target: string | null;
  sessionKey: string | null;
  exists: boolean;
  statusText: string | null;
  source: "session-store" | "gateway-fallback";
};

export type CustomChatAbortResult = {
  ok: true;
  target: string;
  sessionKey: string;
  runId: string | null;
  queued: boolean;
  runtimeTracked: boolean;
  verified?: boolean;
};

export type CustomChatRuntimeStatus = {
  serviceBootstrapped: boolean;
  serviceBootCount: number;
  lastServiceBootAtMs: number | null;
  gatewaySubscriberLoopStarted: boolean;
  gatewayRecoveryLoopStarted: boolean;
  websocketConnected: boolean;
  trackedRunCount: number;
  pendingRpcRequestCount: number;
  lastSubscriberConnectAtMs: number | null;
  lastSubscriberErrorAtMs: number | null;
  lastSubscriberErrorMessage: string | null;
};
