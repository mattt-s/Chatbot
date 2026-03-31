import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock "server-only"
vi.mock("server-only", () => ({}));

import type { ChatEventPayload } from "@/lib/types";

function makePayload(overrides: Partial<ChatEventPayload> = {}): ChatEventPayload {
  return {
    runId: "run-1",
    sessionKey: "panel:p1",
    seq: 1,
    state: "delta",
    message: { text: "hello" },
    ...overrides,
  };
}

describe("customchat-events", () => {
  beforeEach(() => {
    // Clear global listeners between tests
    globalThis.__chatbotCustomChatListeners = undefined;
  });

  describe("publishCustomChatEvent", () => {
    it("calls all subscribed listeners", async () => {
      const { publishCustomChatEvent, subscribeCustomChatEvent } = await import(
        "@/lib/customchat-events"
      );
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      subscribeCustomChatEvent(listener1);
      subscribeCustomChatEvent(listener2);

      const payload = makePayload();
      publishCustomChatEvent(payload);

      expect(listener1).toHaveBeenCalledWith(payload);
      expect(listener2).toHaveBeenCalledWith(payload);
    });

    it("does not throw when a listener throws", async () => {
      const { publishCustomChatEvent, subscribeCustomChatEvent } = await import(
        "@/lib/customchat-events"
      );
      const badListener = vi.fn(() => {
        throw new Error("boom");
      });
      const goodListener = vi.fn();
      subscribeCustomChatEvent(badListener);
      subscribeCustomChatEvent(goodListener);

      expect(() => publishCustomChatEvent(makePayload())).not.toThrow();
      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe("subscribeCustomChatEvent", () => {
    it("returns unsubscribe function", async () => {
      const { publishCustomChatEvent, subscribeCustomChatEvent } = await import(
        "@/lib/customchat-events"
      );
      const listener = vi.fn();
      const unsubscribe = subscribeCustomChatEvent(listener);

      publishCustomChatEvent(makePayload());
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      publishCustomChatEvent(makePayload());
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });
  });
});
