import { sleep } from "./utils.js";
import {
  customChatRuntimeStore,
  markGatewaySubscriberLoopStarted,
  recordGatewaySubscriberError,
  setGatewayRecoveryTimer,
} from "./runtime-store.js";

type RecoveryLoopOptions = {
  recoverTrackedRuns: () => Promise<void>;
  intervalMs: number;
};

type SubscriberLoopOptions = {
  connectOnce: () => Promise<void>;
  restoreTrackedRunsFromRouteState: () => Promise<void>;
  recoverTrackedRuns: () => Promise<void>;
  recoveryIntervalMs: number;
  reconnectDelayMs: number;
};

export function ensureCustomChatRecoveryLoop(options: RecoveryLoopOptions) {
  if (customChatRuntimeStore.gatewayRecoveryTimer) {
    return;
  }

  setGatewayRecoveryTimer(globalThis.setInterval(() => {
    void options.recoverTrackedRuns().catch(() => null);
  }, options.intervalMs));
}

export function ensureCustomChatSubscriberLoop(options: SubscriberLoopOptions) {
  if (customChatRuntimeStore.gatewaySubscriberLoopStarted) {
    return;
  }

  markGatewaySubscriberLoopStarted();
  ensureCustomChatRecoveryLoop({
    recoverTrackedRuns: options.recoverTrackedRuns,
    intervalMs: options.recoveryIntervalMs,
  });
  void options.restoreTrackedRunsFromRouteState().catch(() => null);
  void (async () => {
    while (true) {
      try {
        await options.connectOnce();
      } catch (error) {
        recordGatewaySubscriberError(error);
        console.error("[customchat] gateway subscriber failure", error);
      }
      await sleep(options.reconnectDelayMs);
    }
  })();
}

