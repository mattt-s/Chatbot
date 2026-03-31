import { describe, it, expect } from "vitest";
import {
  nowIso,
  randomId,
  buildSessionKey,
  stripAgentSessionPrefix,
  toCustomChatPanelTarget,
  toCustomChatReplyTarget,
  normalizeCustomChatTarget,
  extractGroupRoleIdFromTarget,
  sanitizeFilename,
  classifyAttachment,
  formatBytes,
  attachmentToView,
  isIgnorableStoredRuntimeStep,
  sanitizeRuntimeSteps,
  messageToView,
  inferMimeTypeFromPath,
  filenameFromUrl,
  extractMessageText,
  extractMessageAttachments,
  toLocalFilePath,
  applyChatEventToMessages,
} from "@/lib/utils";
import type {
  StoredAttachment,
  StoredMessage,
  StoredRuntimeStep,
  MessageView,
  ChatEventPayload,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers to build mock data
// ---------------------------------------------------------------------------

function makeRuntimeStep(overrides: Partial<StoredRuntimeStep> = {}): StoredRuntimeStep {
  return {
    id: "step-1",
    runId: "run-1",
    ts: 1000,
    stream: "tool",
    kind: "step",
    title: "Step",
    description: "",
    detail: null,
    status: "info",
    raw: {},
    ...overrides,
  };
}

function makeStoredAttachment(overrides: Partial<StoredAttachment> = {}): StoredAttachment {
  return {
    id: "att-1",
    name: "photo.png",
    mimeType: "image/png",
    size: 1024,
    kind: "image",
    storagePath: "/storage/uploads/att-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeStoredMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "msg-1",
    panelId: "panel-1",
    role: "assistant",
    text: "Hello world",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    runId: "run-1",
    state: "final",
    draft: false,
    errorMessage: null,
    stopReason: null,
    usage: null,
    runtimeSteps: [],
    ...overrides,
  };
}

function makeMessageView(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: "msg-1",
    role: "assistant",
    text: "Hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    attachments: [],
    runId: "run-1",
    state: "final",
    draft: false,
    errorMessage: null,
    stopReason: null,
    usage: null,
    eventSeq: null,
    runtimeSteps: [],
    ...overrides,
  };
}

function makeChatEvent(overrides: Partial<ChatEventPayload> = {}): ChatEventPayload {
  return {
    runId: "run-2",
    sessionKey: "panel:p1",
    seq: 1,
    state: "delta",
    message: { text: "hi" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nowIso", () => {
  it("returns a valid ISO string", () => {
    const result = nowIso();
    expect(new Date(result).toISOString()).toBe(result);
  });
});

describe("randomId", () => {
  it("returns a non-empty string", () => {
    expect(randomId().length).toBeGreaterThan(0);
  });

  it("returns unique values", () => {
    const ids = new Set(Array.from({ length: 50 }, () => randomId()));
    expect(ids.size).toBe(50);
  });
});

describe("buildSessionKey", () => {
  it("returns panel:<panelId>", () => {
    expect(buildSessionKey("main", "abc")).toBe("panel:abc");
  });
});

describe("stripAgentSessionPrefix", () => {
  it("strips agent:<id>: prefix", () => {
    expect(stripAgentSessionPrefix("agent:main:panel:abc")).toBe("panel:abc");
  });

  it("returns as-is when no agent prefix", () => {
    expect(stripAgentSessionPrefix("panel:abc")).toBe("panel:abc");
  });
});

describe("toCustomChatPanelTarget", () => {
  it("returns panel:<id>", () => {
    expect(toCustomChatPanelTarget("abc")).toBe("panel:abc");
  });
});

describe("toCustomChatReplyTarget", () => {
  it("normalizes known targets", () => {
    expect(toCustomChatReplyTarget("panel:abc")).toBe("panel:abc");
    expect(toCustomChatReplyTarget("channel:abc")).toBe("panel:abc");
  });
});

describe("normalizeCustomChatTarget", () => {
  it("returns null for empty", () => {
    expect(normalizeCustomChatTarget("")).toBeNull();
    expect(normalizeCustomChatTarget("   ")).toBeNull();
  });

  it("normalizes panel: prefix", () => {
    expect(normalizeCustomChatTarget("panel:abc")).toBe("panel:abc");
  });

  it("normalizes channel: to panel:", () => {
    expect(normalizeCustomChatTarget("channel:abc")).toBe("panel:abc");
  });

  it("normalizes session: recursively", () => {
    expect(normalizeCustomChatTarget("session:panel:abc")).toBe("panel:abc");
  });

  it("normalizes direct: with nested colon", () => {
    expect(normalizeCustomChatTarget("direct:panel:abc")).toBe("panel:abc");
  });

  it("normalizes direct: without nested colon", () => {
    expect(normalizeCustomChatTarget("direct:abc")).toBe("panel:abc");
  });

  it("normalizes group: with nested colon", () => {
    expect(normalizeCustomChatTarget("group:panel:abc")).toBe("panel:abc");
  });

  it("normalizes customchat: prefix", () => {
    expect(normalizeCustomChatTarget("customchat:panel:abc")).toBe("panel:abc");
  });

  it("normalizes agent:<id>: prefix", () => {
    expect(normalizeCustomChatTarget("agent:main:panel:abc")).toBe("panel:abc");
  });

  it("normalizes panel-<uuid> pattern", () => {
    expect(normalizeCustomChatTarget("panel-abc123")).toBe("panel:abc123");
  });

  it("returns null for unknown formats", () => {
    expect(normalizeCustomChatTarget("unknown")).toBeNull();
  });

  it("returns null when nested value is empty", () => {
    expect(normalizeCustomChatTarget("panel:")).toBeNull();
    expect(normalizeCustomChatTarget("channel: ")).toBeNull();
  });

  it("handles deeply nested targets", () => {
    expect(
      normalizeCustomChatTarget("agent:main:customchat:group:direct:panel:abc")
    ).toBe("panel:abc");
  });
});

describe("sanitizeFilename", () => {
  it("strips path separators", () => {
    expect(sanitizeFilename("/path/to/file.txt")).toBe("file.txt");
    expect(sanitizeFilename("C:\\path\\file.txt")).toBe("file.txt");
  });

  it("replaces special chars", () => {
    expect(sanitizeFilename("hello world (1).txt")).toBe("hello-world-1.txt");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeFilename("a---b.txt")).toBe("a-b.txt");
  });

  it("returns upload for empty stem", () => {
    expect(sanitizeFilename("!!!.txt")).toBe("upload.txt");
  });

  it("handles no extension", () => {
    expect(sanitizeFilename("readme")).toBe("readme");
  });
});

describe("classifyAttachment", () => {
  it("classifies images", () => {
    expect(classifyAttachment("image/png")).toBe("image");
    expect(classifyAttachment("image/jpeg")).toBe("image");
  });

  it("classifies audio", () => {
    expect(classifyAttachment("audio/mpeg")).toBe("audio");
  });

  it("classifies video", () => {
    expect(classifyAttachment("video/mp4")).toBe("video");
  });

  it("defaults to file", () => {
    expect(classifyAttachment("application/pdf")).toBe("file");
    expect(classifyAttachment("text/plain")).toBe("file");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
  });

  it("formats MB", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formats large MB without decimal", () => {
    expect(formatBytes(15 * 1024 * 1024)).toBe("15 MB");
  });

  it("formats GB", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("attachmentToView", () => {
  it("uses sourceUrl when available", () => {
    const att = makeStoredAttachment({ sourceUrl: "https://example.com/img.png" });
    const view = attachmentToView(att);
    expect(view.url).toBe("https://example.com/img.png");
  });

  it("falls back to /api/uploads/:id", () => {
    const att = makeStoredAttachment({ sourceUrl: null });
    const view = attachmentToView(att);
    expect(view.url).toBe("/api/uploads/att-1");
  });
});

describe("isIgnorableStoredRuntimeStep", () => {
  it("ignores assistant stream", () => {
    expect(isIgnorableStoredRuntimeStep(makeRuntimeStep({ stream: "assistant" }))).toBe(true);
  });

  it("ignores lifecycle stream", () => {
    expect(isIgnorableStoredRuntimeStep(makeRuntimeStep({ stream: "lifecycle" }))).toBe(true);
  });

  it("ignores assistant raw type", () => {
    expect(
      isIgnorableStoredRuntimeStep(makeRuntimeStep({ raw: { type: "assistant" } }))
    ).toBe(true);
  });

  it("keeps tool stream", () => {
    expect(isIgnorableStoredRuntimeStep(makeRuntimeStep({ stream: "tool" }))).toBe(false);
  });
});

describe("sanitizeRuntimeSteps", () => {
  it("filters out ignorable steps", () => {
    const steps = [
      makeRuntimeStep({ id: "1", stream: "tool" }),
      makeRuntimeStep({ id: "2", stream: "assistant" }),
      makeRuntimeStep({ id: "3", stream: "lifecycle" }),
    ];
    expect(sanitizeRuntimeSteps(steps)).toHaveLength(1);
    expect(sanitizeRuntimeSteps(steps)[0].id).toBe("1");
  });
});

describe("messageToView", () => {
  it("converts stored message to view", () => {
    const msg = makeStoredMessage({ eventSeq: 5 });
    const view = messageToView(msg);
    expect(view.id).toBe("msg-1");
    expect(view.role).toBe("assistant");
    expect(view.eventSeq).toBe(5);
    expect(view.runtimeSteps).toEqual([]);
  });

  it("filters ignorable runtime steps", () => {
    const msg = makeStoredMessage({
      runtimeSteps: [
        makeRuntimeStep({ id: "1", stream: "tool" }),
        makeRuntimeStep({ id: "2", stream: "lifecycle" }),
      ],
    });
    const view = messageToView(msg);
    expect(view.runtimeSteps).toHaveLength(1);
  });
});

describe("inferMimeTypeFromPath", () => {
  it("detects common image types", () => {
    expect(inferMimeTypeFromPath("photo.png")).toBe("image/png");
    expect(inferMimeTypeFromPath("photo.jpg")).toBe("image/jpeg");
    expect(inferMimeTypeFromPath("photo.jpeg")).toBe("image/jpeg");
    expect(inferMimeTypeFromPath("photo.gif")).toBe("image/gif");
    expect(inferMimeTypeFromPath("photo.webp")).toBe("image/webp");
    expect(inferMimeTypeFromPath("photo.svg")).toBe("image/svg+xml");
  });

  it("detects video types", () => {
    expect(inferMimeTypeFromPath("video.mp4")).toBe("video/mp4");
    expect(inferMimeTypeFromPath("video.webm")).toBe("video/webm");
    expect(inferMimeTypeFromPath("video.mov")).toBe("video/quicktime");
  });

  it("detects audio types", () => {
    expect(inferMimeTypeFromPath("song.mp3")).toBe("audio/mpeg");
    expect(inferMimeTypeFromPath("sound.wav")).toBe("audio/wav");
    expect(inferMimeTypeFromPath("track.ogg")).toBe("audio/ogg");
  });

  it("detects document types", () => {
    expect(inferMimeTypeFromPath("doc.pdf")).toBe("application/pdf");
    expect(inferMimeTypeFromPath("notes.md")).toBe("text/markdown");
    expect(inferMimeTypeFromPath("readme.txt")).toBe("text/plain");
  });

  it("returns octet-stream for unknown", () => {
    expect(inferMimeTypeFromPath("data.xyz")).toBe("application/octet-stream");
  });

  it("strips query and hash", () => {
    expect(inferMimeTypeFromPath("photo.png?v=1")).toBe("image/png");
    expect(inferMimeTypeFromPath("photo.png#section")).toBe("image/png");
  });
});

describe("filenameFromUrl", () => {
  it("extracts filename from URL", () => {
    expect(filenameFromUrl("https://example.com/path/to/photo.png")).toBe("photo.png");
  });

  it("strips query params", () => {
    expect(filenameFromUrl("https://example.com/file.pdf?v=1")).toBe("file.pdf");
  });

  it("handles file:// protocol", () => {
    expect(filenameFromUrl("file:///home/user/doc.txt")).toBe("doc.txt");
  });

  it("returns attachment for empty", () => {
    expect(filenameFromUrl("")).toBe("attachment");
  });
});

describe("toLocalFilePath", () => {
  it("returns absolute unix paths", () => {
    expect(toLocalFilePath("/home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("returns Windows paths", () => {
    expect(toLocalFilePath("C:\\Users\\file.txt")).toBe("C:\\Users\\file.txt");
  });

  it("converts file:// URLs", () => {
    expect(toLocalFilePath("file:///home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("returns null for http URLs", () => {
    expect(toLocalFilePath("https://example.com/file.txt")).toBeNull();
  });

  it("returns null for empty", () => {
    expect(toLocalFilePath("")).toBeNull();
    expect(toLocalFilePath("   ")).toBeNull();
  });
});

describe("extractMessageText", () => {
  it("extracts from text field", () => {
    expect(extractMessageText({ text: "hello" })).toBe("hello");
  });

  it("strips NO_REPLY", () => {
    expect(extractMessageText({ text: "hello NO_REPLY" })).toBe("hello ");
  });

  it("extracts from content array", () => {
    const msg = {
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
    };
    expect(extractMessageText(msg)).toBe("part1\npart2");
  });

  it("returns empty for null/undefined", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText(42)).toBe("");
  });

  it("returns empty for non-text content", () => {
    expect(extractMessageText({ content: [{ type: "image" }] })).toBe("");
  });
});

describe("extractMessageAttachments", () => {
  it("returns empty for null", () => {
    expect(extractMessageAttachments(null)).toEqual([]);
  });

  it("extracts from content array with source", () => {
    const msg = {
      content: [
        {
          type: "image",
          source: {
            media_type: "image/png",
            data: "aGVsbG8=",
          },
        },
      ],
    };
    const result = extractMessageAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].mimeType).toBe("image/png");
    expect(result[0].url).toContain("data:image/png;base64,");
  });

  it("extracts MEDIA: references from text", () => {
    const msg = { text: "MEDIA: https://example.com/photo.png" };
    const result = extractMessageAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/photo.png");
    expect(result[0].mimeType).toBe("image/png");
  });

  it("extracts markdown image references", () => {
    const msg = { text: "![alt](https://example.com/img.jpg)" };
    const result = extractMessageAttachments(msg);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/img.jpg");
  });

  it("deduplicates by URL", () => {
    const msg = {
      text: "MEDIA: https://example.com/img.png\nMEDIA: https://example.com/img.png",
    };
    const result = extractMessageAttachments(msg);
    expect(result).toHaveLength(1);
  });
});

describe("applyChatEventToMessages", () => {
  it("creates new message for delta with new runId", () => {
    const result = applyChatEventToMessages([], makeChatEvent());
    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("run-2");
    expect(result[0].state).toBe("delta");
    expect(result[0].draft).toBe(true);
  });

  it("updates existing message for same runId delta", () => {
    const existing = [makeMessageView({ runId: "run-2", state: "delta", draft: true, eventSeq: 0 })];
    const event = makeChatEvent({ runId: "run-2", seq: 1, message: { text: "updated" } });
    const result = applyChatEventToMessages(existing, event);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("updated");
    expect(result[0].eventSeq).toBe(1);
  });

  it("rejects out-of-order seq for delta", () => {
    const existing = [
      makeMessageView({ runId: "run-2", state: "delta", draft: true, eventSeq: 5, text: "latest" }),
    ];
    const event = makeChatEvent({ runId: "run-2", seq: 3, message: { text: "old" } });
    const result = applyChatEventToMessages(existing, event);
    expect(result[0].text).toBe("latest");
    expect(result[0].eventSeq).toBe(5);
  });

  it("handles final state on existing message", () => {
    const existing = [makeMessageView({ runId: "run-2", state: "delta", draft: true, eventSeq: 1 })];
    const event = makeChatEvent({
      runId: "run-2",
      seq: 2,
      state: "final",
      message: { text: "done" },
      stopReason: "end_turn",
    });
    const result = applyChatEventToMessages(existing, event);
    expect(result[0].state).toBe("final");
    expect(result[0].draft).toBe(false);
    expect(result[0].text).toBe("done");
    expect(result[0].stopReason).toBe("end_turn");
  });

  it("creates new message for final with unknown runId", () => {
    const result = applyChatEventToMessages(
      [],
      makeChatEvent({ state: "final", message: { text: "complete" } })
    );
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("final");
    expect(result[0].draft).toBe(false);
  });

  it("handles error state", () => {
    const result = applyChatEventToMessages(
      [],
      makeChatEvent({ state: "error", errorMessage: "LLM timeout" })
    );
    expect(result).toHaveLength(1);
    expect(result[0].state).toBe("error");
    expect(result[0].errorMessage).toBe("LLM timeout");
  });

  it("handles error on existing message", () => {
    const existing = [makeMessageView({ runId: "run-2", state: "delta", draft: true, eventSeq: 1 })];
    const event = makeChatEvent({ runId: "run-2", seq: 2, state: "error", errorMessage: "fail" });
    const result = applyChatEventToMessages(existing, event);
    expect(result[0].state).toBe("error");
    expect(result[0].draft).toBe(false);
    expect(result[0].errorMessage).toBe("fail");
  });

  it("merges runtime steps by id", () => {
    const existing = [
      makeMessageView({
        runId: "run-2",
        state: "delta",
        draft: true,
        eventSeq: 0,
        runtimeSteps: [makeRuntimeStep({ id: "s1", status: "running" })],
      }),
    ];
    const event = makeChatEvent({
      runId: "run-2",
      seq: 1,
      runtimeSteps: [makeRuntimeStep({ id: "s1", status: "done" })],
    });
    const result = applyChatEventToMessages(existing, event);
    expect(result[0].runtimeSteps).toHaveLength(1);
    expect(result[0].runtimeSteps[0].status).toBe("done");
  });

  it("handles aborted state", () => {
    const result = applyChatEventToMessages(
      [],
      makeChatEvent({ state: "aborted", message: { text: "partial" } })
    );
    expect(result[0].state).toBe("aborted");
    expect(result[0].draft).toBe(false);
  });

  it("preserves group role metadata during live updates", () => {
    const event = makeChatEvent({
      state: "delta",
      groupRoleId: "role-coder",
      senderLabel: "Coder",
      mentionedGroupRoleIds: ["role-manager"],
      message: { text: "正在分析" },
    });
    const result = applyChatEventToMessages([], event);
    expect(result[0].groupRoleId).toBe("role-coder");
    expect(result[0].senderLabel).toBe("Coder");
    expect(result[0].mentionedGroupRoleIds).toEqual(["role-manager"]);
  });

  it("sorts messages by createdAt", () => {
    const messages = [
      makeMessageView({ id: "2", runId: "r2", createdAt: "2026-01-02T00:00:00Z" }),
      makeMessageView({ id: "1", runId: "r1", createdAt: "2026-01-01T00:00:00Z" }),
    ];
    const result = applyChatEventToMessages(messages, makeChatEvent({ runId: "r3", seq: 0 }));
    expect(result[0].id).toBe("1");
    expect(result[1].id).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// group role target handling
// ---------------------------------------------------------------------------

describe("normalizeCustomChatTarget – group role target", () => {
  it("extracts panelId from group:direct:panelId:role:roleId", () => {
    expect(normalizeCustomChatTarget("group:direct:abc-123:role:role-1")).toBe("panel:abc-123");
  });

  it("returns null for malformed new group role target", () => {
    expect(normalizeCustomChatTarget("group:direct:")).toBeNull();
  });

  it("handles group role target inside agent: prefix via recursion", () => {
    expect(
      normalizeCustomChatTarget("agent:main:customchat:group:direct:abc:role:role1"),
    ).toBe("panel:abc");
  });

  it("keeps supporting legacy grp target", () => {
    expect(normalizeCustomChatTarget("grp:abc-123:r:role-1")).toBe("panel:abc-123");
  });
});

describe("extractGroupRoleIdFromTarget", () => {
  it("extracts roleId from group:direct:panelId:role:roleId", () => {
    expect(extractGroupRoleIdFromTarget("group:direct:abc:role:role-1")).toBe("role-1");
  });

  it("returns null for non-grp target", () => {
    expect(extractGroupRoleIdFromTarget("panel:abc")).toBeNull();
    expect(extractGroupRoleIdFromTarget("direct:abc")).toBeNull();
  });

  it("returns null for malformed target", () => {
    expect(extractGroupRoleIdFromTarget("group:direct:abc")).toBeNull();
  });

  it("keeps supporting legacy grp target", () => {
    expect(extractGroupRoleIdFromTarget("grp:abc:r:role-1")).toBe("role-1");
  });
});
