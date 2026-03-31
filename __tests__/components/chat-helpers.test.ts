import { describe, it, expect } from "vitest";
import type { ChatEventPayload, MessageView, StoredRuntimeStep } from "@/lib/types";

// Import non-JSX functions only (skip renderLinkedText / buildOptimisticUserMessage which need React/DOM)
import {
  truncateText,
  matchesPanelSession,
  normalizeChatEventRunId,
  isBridgeDeliveryMessage,
  shouldHideBridgeDeliveryNoiseText,
} from "@/components/chat-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessageView(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "msg-1",
    role: "assistant",
    text: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    runId: "run-1",
    state: "delta",
    draft: true,
    errorMessage: null,
    stopReason: null,
    usage: null,
    eventSeq: null,
    runtimeSteps: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ChatEventPayload> = {}): ChatEventPayload {
  return {
    runId: "run-new",
    sessionKey: "panel:p1",
    seq: 1,
    state: "final",
    message: { text: "hi" },
    ...overrides,
  };
}

function makeStep(overrides: Partial<StoredRuntimeStep> = {}): StoredRuntimeStep {
  return {
    id: "s1",
    runId: "run-1",
    ts: 1000,
    stream: "tool",
    kind: "exec",
    title: "Exec",
    description: "ls",
    detail: null,
    status: "done",
    raw: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("truncateText", () => {
  it("returns short text as-is", () => {
    expect(truncateText("hello")).toBe("hello");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(200);
    const result = truncateText(long, 180);
    expect(result.length).toBe(180);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("matchesPanelSession", () => {
  it("returns false for null event key", () => {
    expect(matchesPanelSession(null, "panel:p1")).toBe(false);
  });

  it("matches exact session key", () => {
    expect(matchesPanelSession("panel:p1", "panel:p1")).toBe(true);
  });

  it("matches after normalization", () => {
    expect(matchesPanelSession("channel:p1", "panel:p1")).toBe(true);
  });

  it("does not match different panels", () => {
    expect(matchesPanelSession("panel:p2", "panel:p1")).toBe(false);
  });
});

describe("normalizeChatEventRunId", () => {
  it("returns event unchanged when no activeRunId", () => {
    const event = makeEvent();
    const result = normalizeChatEventRunId([], event, null);
    expect(result.runId).toBe("run-new");
  });

  it("returns event unchanged when activeRunId equals event runId", () => {
    const event = makeEvent({ runId: "run-1" });
    const result = normalizeChatEventRunId([], event, "run-1");
    expect(result.runId).toBe("run-1");
  });

  it("returns event unchanged for delta state", () => {
    const event = makeEvent({ state: "delta" });
    const result = normalizeChatEventRunId([], event, "customchat:uuid-123");
    expect(result.runId).toBe("run-new");
  });

  it("merges runId when activeRunId is customchat:* and event is final", () => {
    const messages = [
      makeMessageView({ runId: "customchat:uuid-123", draft: true }),
    ];
    const event = makeEvent({ runId: "gateway-run-id", state: "final" });
    const result = normalizeChatEventRunId(messages, event, "customchat:uuid-123");
    expect(result.runId).toBe("customchat:uuid-123"); // merged
  });

  it("does NOT merge when activeRunId is a real gateway runId", () => {
    const messages = [
      makeMessageView({ runId: "h0sbzk3zg6q", draft: true }),
    ];
    const event = makeEvent({ runId: "customchat:new-delivery", state: "final" });
    const result = normalizeChatEventRunId(messages, event, "h0sbzk3zg6q");
    expect(result.runId).toBe("customchat:new-delivery"); // not merged
  });

  it("does NOT merge when both are customchat:*", () => {
    const messages = [
      makeMessageView({ runId: "customchat:old", draft: true }),
    ];
    const event = makeEvent({ runId: "customchat:new", state: "final" });
    const result = normalizeChatEventRunId(messages, event, "customchat:old");
    expect(result.runId).toBe("customchat:new"); // not merged
  });

  it("does NOT merge when no draft exists for activeRunId", () => {
    const messages = [
      makeMessageView({ runId: "customchat:uuid-123", draft: false }),
    ];
    const event = makeEvent({ runId: "gateway-run", state: "final" });
    const result = normalizeChatEventRunId(messages, event, "customchat:uuid-123");
    expect(result.runId).toBe("gateway-run"); // no draft → no merge
  });
});

describe("isBridgeDeliveryMessage", () => {
  it("returns false for user messages", () => {
    expect(isBridgeDeliveryMessage(makeMessageView({ role: "user" }))).toBe(false);
  });

  it("returns false when has attachments", () => {
    const msg = makeMessageView({
      attachments: [
        {
          id: "a1",
          name: "img.png",
          mimeType: "image/png",
          size: 100,
          kind: "image",
          url: "/api/uploads/a1",
        },
      ],
    });
    expect(isBridgeDeliveryMessage(msg)).toBe(false);
  });

  it("returns false when has runtime steps", () => {
    const msg = makeMessageView({
      runtimeSteps: [makeStep()],
    });
    expect(isBridgeDeliveryMessage(msg)).toBe(false);
  });

  it("returns true for empty assistant message", () => {
    expect(isBridgeDeliveryMessage(makeMessageView({ text: "" }))).toBe(true);
  });

  it("returns true for assistant with text 'no'", () => {
    expect(isBridgeDeliveryMessage(makeMessageView({ text: "no" }))).toBe(true);
    expect(isBridgeDeliveryMessage(makeMessageView({ text: "NO" }))).toBe(true);
    expect(isBridgeDeliveryMessage(makeMessageView({ text: "  No  " }))).toBe(true);
  });

  it("returns false for assistant with real text", () => {
    expect(isBridgeDeliveryMessage(makeMessageView({ text: "Hello!" }))).toBe(false);
  });

  it("does not hide a parent run with runtime steps as a whole bubble", () => {
    const msg = makeMessageView({
      text: "NO",
      runtimeSteps: [makeStep({ raw: { tool: "message" } })],
    });
    expect(isBridgeDeliveryMessage(msg)).toBe(false);
  });
});

describe("shouldHideBridgeDeliveryNoiseText", () => {
  it("does not hide a plain 'NO' when there is no nearby tool delivery result", () => {
    const msg = makeMessageView({
      text: "NO",
      runtimeSteps: [makeStep({ raw: { tool: "message" } })],
    });
    expect(shouldHideBridgeDeliveryNoiseText(msg, [msg], 0)).toBe(false);
  });

  it("hides a 'NO' tail when message tool already produced a nearby delivery result", () => {
    const parent = makeMessageView({
      id: "parent",
      text: "NO",
      createdAt: "2026-01-01T00:00:07.000Z",
      runId: "run-parent",
      state: "final",
      draft: false,
      runtimeSteps: [makeStep({ raw: { tool: "message" } })],
    });
    const delivered = makeMessageView({
      id: "delivered",
      text: "豆豆的头像 🐶",
      createdAt: "2026-01-01T00:00:05.000Z",
      runId: "customchat:delivery",
      state: "final",
      draft: false,
      attachments: [
        {
          id: "a1",
          name: "avatar.jpg",
          mimeType: "image/jpeg",
          size: 100,
          kind: "image",
          url: "/api/uploads/a1",
        },
      ],
      runtimeSteps: [],
    });

    expect(shouldHideBridgeDeliveryNoiseText(parent, [delivered, parent], 1)).toBe(true);
  });

  it("does not hide a regular short answer without message tool step", () => {
    const msg = makeMessageView({
      text: "NO",
      runtimeSteps: [makeStep({ raw: { tool: "bash" } })],
    });
    expect(shouldHideBridgeDeliveryNoiseText(msg, [msg], 0)).toBe(false);
  });
});
