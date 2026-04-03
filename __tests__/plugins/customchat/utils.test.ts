import { describe, it, expect } from "vitest";
import {
  type SessionSnapshot,
  asJsonRecord,
  dedupeStrings,
  parseTimestampMs,
  collectStringValues,
  extractStringValue,
  sanitizeFilename,
  normalizePathSegment,
  fileNameFromPath,
  filenameFromUrl,
  inferMimeType,
  inferMimeTypeFromUrl,
  guessImageMimeType,
  toLocalFilePath,
  isHttpUrl,
  isDataUrl,
  sanitizeMediaRef,
  extractMediaRefsFromText,
  stripMediaRefsFromText,
  isTextLikeFile,
  flattenMediaInputs,
  normalizeChannelTarget,
  buildCanonicalSessionKey,
  normalizeSessionKeyCandidate,
  extractText,
  extractTarget,
  extractSessionKeyHint,
  extractRunId,
  buildMessageId,
  extractTextFromMessagePayload,
  extractMessageRole,
  isDeliveryMirrorMessage,
  summarizeToolArguments,
  extractLatestAssistantTextFromMessages,
  extractLatestAssistantTextForCurrentTurn,
  extractLatestAssistantText,
  extractCurrentTurnMessages,
  looksLikeSessionRecord,
  flattenSessionRecords,
  toSessionSnapshot,
  scoreSessionSnapshot,
  sessionShowsAbortedLastRun,
  parseGatewayWaitStatus,
  isTerminalGatewayWaitStatus,
  looksLikeAgentRecord,
  flattenAgentRecords,
  toAgentView,
  parseJsonOutput,
  readAuthorizationToken,
  buildInboundAgentMessage,
  base64UrlEncode,
  buildDeviceAuthPayloadV3,
  MIME_BY_EXT,
} from "../../../plugins/customchat/utils";

// =========================================================================
// asJsonRecord
// =========================================================================
describe("asJsonRecord", () => {
  it("returns object as-is", () => {
    const obj = { a: 1 };
    expect(asJsonRecord(obj)).toBe(obj);
  });
  it("returns empty object for null", () => {
    expect(asJsonRecord(null)).toEqual({});
  });
  it("returns empty object for undefined", () => {
    expect(asJsonRecord(undefined)).toEqual({});
  });
  it("returns empty object for array", () => {
    expect(asJsonRecord([1, 2])).toEqual({});
  });
  it("returns empty object for string", () => {
    expect(asJsonRecord("hello")).toEqual({});
  });
  it("returns empty object for number", () => {
    expect(asJsonRecord(42)).toEqual({});
  });
});

// =========================================================================
// dedupeStrings
// =========================================================================
describe("dedupeStrings", () => {
  it("removes duplicates preserving order", () => {
    expect(dedupeStrings(["a", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
  it("filters null/undefined/empty", () => {
    expect(dedupeStrings([null, undefined, "", "a", "  "])).toEqual(["a"]);
  });
  it("trims values", () => {
    expect(dedupeStrings(["  x  ", "x"])).toEqual(["x"]);
  });
  it("respects limit", () => {
    expect(dedupeStrings(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
  });
  it("returns empty for empty input", () => {
    expect(dedupeStrings([])).toEqual([]);
  });
});

// =========================================================================
// parseTimestampMs
// =========================================================================
describe("parseTimestampMs", () => {
  it("returns number as-is", () => {
    expect(parseTimestampMs(1700000000000)).toBe(1700000000000);
  });
  it("parses ISO string", () => {
    const iso = "2024-01-01T00:00:00.000Z";
    expect(parseTimestampMs(iso)).toBe(Date.parse(iso));
  });
  it("returns 0 for null", () => {
    expect(parseTimestampMs(null)).toBe(0);
  });
  it("returns 0 for invalid string", () => {
    expect(parseTimestampMs("not-a-date")).toBe(0);
  });
  it("returns 0 for NaN", () => {
    expect(parseTimestampMs(NaN)).toBe(0);
  });
  it("returns 0 for empty string", () => {
    expect(parseTimestampMs("")).toBe(0);
  });
});

// =========================================================================
// collectStringValues
// =========================================================================
describe("collectStringValues", () => {
  it("returns trimmed string in array", () => {
    expect(collectStringValues("hello")).toEqual(["hello"]);
  });
  it("returns empty for whitespace-only string", () => {
    expect(collectStringValues("   ")).toEqual([]);
  });
  it("flattens object values", () => {
    expect(collectStringValues({ a: "x", b: "y" })).toEqual(["x", "y"]);
  });
  it("flattens arrays", () => {
    expect(collectStringValues(["a", "b"])).toEqual(["a", "b"]);
  });
  it("traverses nested objects", () => {
    expect(collectStringValues({ a: { b: "deep" } })).toEqual(["deep"]);
  });
  it("respects depth limit of 5", () => {
    let obj: unknown = "leaf";
    for (let i = 0; i < 7; i++) obj = { child: obj };
    // depth > 5 → empty
    expect(collectStringValues(obj)).toEqual([]);
  });
  it("returns empty for null", () => {
    expect(collectStringValues(null)).toEqual([]);
  });
  it("handles circular references via seen set", () => {
    const obj: { a: string; self?: unknown } = { a: "val" };
    obj.self = obj;
    expect(collectStringValues(obj)).toEqual(["val"]);
  });
});

// =========================================================================
// extractStringValue
// =========================================================================
describe("extractStringValue", () => {
  it("returns trimmed string", () => {
    expect(extractStringValue("  hello  ")).toBe("hello");
  });
  it("returns empty for empty string", () => {
    expect(extractStringValue("")).toBe("");
  });
  it("returns empty for non-string", () => {
    expect(extractStringValue(42)).toBe("");
    expect(extractStringValue(null)).toBe("");
  });
});

// =========================================================================
// sanitizeFilename
// =========================================================================
describe("sanitizeFilename", () => {
  it("returns simple filename unchanged", () => {
    expect(sanitizeFilename("test.txt")).toBe("test.txt");
  });
  it("extracts filename from path", () => {
    expect(sanitizeFilename("/home/user/doc.pdf")).toBe("doc.pdf");
  });
  it("extracts filename from Windows path", () => {
    expect(sanitizeFilename("C:\\Users\\doc.pdf")).toBe("doc.pdf");
  });
  it("replaces special characters with dash", () => {
    expect(sanitizeFilename("hello world!@#.txt")).toBe("hello-world.txt");
  });
  it("collapses consecutive dashes", () => {
    expect(sanitizeFilename("a---b.txt")).toBe("a-b.txt");
  });
  it("strips leading/trailing dashes from stem", () => {
    expect(sanitizeFilename("-test-.txt")).toBe("test.txt");
  });
  it("returns 'attachment' for empty stem", () => {
    expect(sanitizeFilename("!!!.png")).toBe("attachment.png");
  });
  it("returns 'attachment' for empty input (via pop)", () => {
    expect(sanitizeFilename("")).toBe("attachment");
  });
});

// =========================================================================
// normalizePathSegment
// =========================================================================
describe("normalizePathSegment", () => {
  it("returns trimmed value", () => {
    expect(normalizePathSegment("hello", "fb")).toBe("hello");
  });
  it("returns fallback for empty", () => {
    expect(normalizePathSegment("   ", "fb")).toBe("fb");
  });
  it("replaces slashes with underscore", () => {
    expect(normalizePathSegment("a/b\\c", "fb")).toBe("a_b_c");
  });
  it("replaces consecutive dots", () => {
    expect(normalizePathSegment("a..b...c", "fb")).toBe("a.b.c");
  });
});

// =========================================================================
// fileNameFromPath
// =========================================================================
describe("fileNameFromPath", () => {
  it("extracts Unix filename", () => {
    expect(fileNameFromPath("/home/user/file.txt")).toBe("file.txt");
  });
  it("extracts Windows filename", () => {
    expect(fileNameFromPath("C:\\Users\\file.txt")).toBe("file.txt");
  });
  it("returns 'attachment' for empty segments", () => {
    expect(fileNameFromPath("")).toBe("attachment");
  });
});

// =========================================================================
// filenameFromUrl
// =========================================================================
describe("filenameFromUrl", () => {
  it("extracts from HTTP URL", () => {
    expect(filenameFromUrl("https://example.com/images/photo.jpg")).toBe("photo.jpg");
  });
  it("strips query and hash", () => {
    expect(filenameFromUrl("https://example.com/file.pdf?v=1#section")).toBe("file.pdf");
  });
  it("handles file:// URLs", () => {
    expect(filenameFromUrl("file:///home/user/doc.txt")).toBe("doc.txt");
  });
  it("returns 'attachment' for empty", () => {
    expect(filenameFromUrl("")).toBe("attachment");
  });
});

// =========================================================================
// inferMimeType / inferMimeTypeFromUrl
// =========================================================================
describe("inferMimeType", () => {
  it("returns image/png for .png", () => {
    expect(inferMimeType("file.png")).toBe("image/png");
  });
  it("returns application/pdf for .pdf", () => {
    expect(inferMimeType("doc.pdf")).toBe("application/pdf");
  });
  it("returns text/plain for .txt", () => {
    expect(inferMimeType("notes.txt")).toBe("text/plain");
  });
  it("returns octet-stream for unknown", () => {
    expect(inferMimeType("file.xyz")).toBe("application/octet-stream");
  });
  it("is case-insensitive via path.extname", () => {
    expect(inferMimeType("FILE.PNG")).toBe("image/png");
  });
});

describe("inferMimeTypeFromUrl", () => {
  it("strips query before inferring", () => {
    expect(inferMimeTypeFromUrl("https://cdn.example.com/img.jpg?w=100")).toBe("image/jpeg");
  });
  it("strips hash before inferring", () => {
    expect(inferMimeTypeFromUrl("https://cdn.example.com/img.gif#preview")).toBe("image/gif");
  });
});

// =========================================================================
// guessImageMimeType
// =========================================================================
describe("guessImageMimeType", () => {
  it("detects png", () => expect(guessImageMimeType("a.png")).toBe("image/png"));
  it("detects jpg", () => expect(guessImageMimeType("a.jpg")).toBe("image/jpeg"));
  it("detects jpeg", () => expect(guessImageMimeType("a.jpeg")).toBe("image/jpeg"));
  it("detects webp", () => expect(guessImageMimeType("a.webp")).toBe("image/webp"));
  it("detects gif", () => expect(guessImageMimeType("a.gif")).toBe("image/gif"));
  it("detects svg", () => expect(guessImageMimeType("a.svg")).toBe("image/svg+xml"));
  it("returns octet-stream for unknown", () => expect(guessImageMimeType("a.bmp")).toBe("application/octet-stream"));
});

// =========================================================================
// toLocalFilePath
// =========================================================================
describe("toLocalFilePath", () => {
  it("returns Unix absolute path", () => {
    expect(toLocalFilePath("/home/user/file.txt")).toBe("/home/user/file.txt");
  });
  it("returns Windows path", () => {
    expect(toLocalFilePath("C:\\Users\\file.txt")).toBe("C:\\Users\\file.txt");
  });
  it("parses file:// URL", () => {
    expect(toLocalFilePath("file:///tmp/file.txt")).toBe("/tmp/file.txt");
  });
  it("decodes percent-encoded file:// URL", () => {
    expect(toLocalFilePath("file:///tmp/my%20file.txt")).toBe("/tmp/my file.txt");
  });
  it("returns null for HTTP URL", () => {
    expect(toLocalFilePath("https://example.com/file")).toBeNull();
  });
  it("returns null for empty string", () => {
    expect(toLocalFilePath("")).toBeNull();
  });
  it("returns null for relative path", () => {
    expect(toLocalFilePath("relative/path")).toBeNull();
  });
});

// =========================================================================
// isHttpUrl / isDataUrl
// =========================================================================
describe("isHttpUrl", () => {
  it("matches http://", () => expect(isHttpUrl("http://example.com")).toBe(true));
  it("matches https://", () => expect(isHttpUrl("https://example.com")).toBe(true));
  it("rejects file://", () => expect(isHttpUrl("file:///tmp")).toBe(false));
  it("rejects data:", () => expect(isHttpUrl("data:text/plain")).toBe(false));
  it("rejects empty", () => expect(isHttpUrl("")).toBe(false));
});

describe("isDataUrl", () => {
  it("matches data: prefix", () => expect(isDataUrl("data:image/png;base64,abc")).toBe(true));
  it("rejects http", () => expect(isDataUrl("http://example.com")).toBe(false));
  it("rejects empty", () => expect(isDataUrl("")).toBe(false));
});

// =========================================================================
// sanitizeMediaRef
// =========================================================================
describe("sanitizeMediaRef", () => {
  it("strips double quotes", () => {
    expect(sanitizeMediaRef('"path/to/file"')).toBe("path/to/file");
  });
  it("strips single quotes", () => {
    expect(sanitizeMediaRef("'path/to/file'")).toBe("path/to/file");
  });
  it("strips backticks", () => {
    expect(sanitizeMediaRef("`path/to/file`")).toBe("path/to/file");
  });
  it("strips trailing punctuation", () => {
    expect(sanitizeMediaRef("file.png).")).toBe("file.png");
  });
  it("trims whitespace", () => {
    expect(sanitizeMediaRef("  file.png  ")).toBe("file.png");
  });
});

// =========================================================================
// extractMediaRefsFromText / stripMediaRefsFromText
// =========================================================================
describe("extractMediaRefsFromText", () => {
  it("extracts MEDIA: references", () => {
    const text = "Hello\nMEDIA: /tmp/file.png\nWorld";
    expect(extractMediaRefsFromText(text)).toEqual(["/tmp/file.png"]);
  });
  it("extracts markdown image references", () => {
    const text = "See ![alt](https://example.com/img.png) here";
    expect(extractMediaRefsFromText(text)).toEqual(["https://example.com/img.png"]);
  });
  it("extracts both MEDIA and markdown", () => {
    const text = "MEDIA:/a.png\n![](b.png)";
    const refs = extractMediaRefsFromText(text);
    expect(refs).toContain("/a.png");
    expect(refs).toContain("b.png");
  });
  it("deduplicates refs", () => {
    const text = "MEDIA:/a.png\nMEDIA:/a.png";
    expect(extractMediaRefsFromText(text)).toEqual(["/a.png"]);
  });
  it("returns empty for no refs", () => {
    expect(extractMediaRefsFromText("no media here")).toEqual([]);
  });
});

describe("stripMediaRefsFromText", () => {
  it("removes MEDIA lines", () => {
    const text = "Hello\nMEDIA: /tmp/file.png\nWorld";
    expect(stripMediaRefsFromText(text)).toBe("Hello\n\nWorld");
  });
  it("collapses multiple blank lines", () => {
    const text = "Hello\nMEDIA: /a\n\n\n\nWorld";
    expect(stripMediaRefsFromText(text)).toBe("Hello\n\nWorld");
  });
});

// =========================================================================
// isTextLikeFile
// =========================================================================
describe("isTextLikeFile", () => {
  it("recognizes text/ mime", () => expect(isTextLikeFile("a.txt", "text/plain")).toBe(true));
  it("recognizes application/json", () => expect(isTextLikeFile("a.json", "application/json")).toBe(true));
  it("recognizes .md by extension", () => expect(isTextLikeFile("readme.md", "application/octet-stream")).toBe(true));
  it("recognizes .txt by extension", () => expect(isTextLikeFile("notes.txt", "application/octet-stream")).toBe(true));
  it("recognizes .json by extension", () => expect(isTextLikeFile("data.json", "application/octet-stream")).toBe(true));
  it("rejects image", () => expect(isTextLikeFile("img.png", "image/png")).toBe(false));
});

// =========================================================================
// flattenMediaInputs
// =========================================================================
describe("flattenMediaInputs", () => {
  it("returns empty for null", () => expect(flattenMediaInputs(null)).toEqual([]));
  it("wraps single value", () => expect(flattenMediaInputs("a")).toEqual(["a"]));
  it("flattens nested arrays", () => {
    expect(flattenMediaInputs([["a"], [["b"]], "c"])).toEqual(["a", "b", "c"]);
  });
  it("returns empty for undefined", () => expect(flattenMediaInputs(undefined)).toEqual([]));
});

// =========================================================================
// normalizeChannelTarget — most complex pure function
// =========================================================================
describe("normalizeChannelTarget", () => {
  it("normalizes direct:abc", () => {
    expect(normalizeChannelTarget("direct:abc")).toBe("direct:abc");
  });
  it("normalizes panel:abc → direct:abc", () => {
    expect(normalizeChannelTarget("panel:abc")).toBe("direct:abc");
  });
  it("normalizes channel:abc → direct:abc", () => {
    expect(normalizeChannelTarget("channel:abc")).toBe("direct:abc");
  });
  it("strips session: prefix recursively", () => {
    expect(normalizeChannelTarget("session:direct:abc")).toBe("direct:abc");
  });
  it("handles agent:main:customchat:group:direct:uuid", () => {
    expect(normalizeChannelTarget("agent:main:customchat:group:direct:uuid-123")).toBe("direct:uuid-123");
  });
  it("passes through new group role target", () => {
    expect(normalizeChannelTarget("group:direct:abc:role:role-1")).toBe("group:direct:abc:role:role-1");
  });
  it("handles group:direct:abc", () => {
    expect(normalizeChannelTarget("group:direct:abc")).toBe("direct:abc");
  });
  it("handles customchat:group:direct:abc", () => {
    expect(normalizeChannelTarget("customchat:group:direct:abc")).toBe("direct:abc");
  });
  it("handles deeply nested prefixes", () => {
    expect(normalizeChannelTarget("session:agent:main:customchat:group:direct:abc")).toBe("direct:abc");
  });
  it("returns null for empty", () => {
    expect(normalizeChannelTarget("")).toBeNull();
  });
  it("returns null for undefined", () => {
    expect(normalizeChannelTarget(undefined)).toBeNull();
  });
  it("returns null for whitespace only", () => {
    expect(normalizeChannelTarget("   ")).toBeNull();
  });
  it("returns null for unknown prefix without colon", () => {
    expect(normalizeChannelTarget("abc")).toBeNull();
  });
  it("returns null for agent: with < 3 parts", () => {
    expect(normalizeChannelTarget("agent:main")).toBeNull();
  });
  it("direct: with nested colons recurses", () => {
    expect(normalizeChannelTarget("direct:channel:abc")).toBe("direct:abc");
  });
  it("group: with no nested colon", () => {
    expect(normalizeChannelTarget("group:abc")).toBe("direct:abc");
  });
  it("customchat: with no nested colon", () => {
    expect(normalizeChannelTarget("customchat:abc")).toBe("direct:abc");
  });
  it("panel: with empty id", () => {
    expect(normalizeChannelTarget("panel:")).toBeNull();
  });
  it("channel: with empty id", () => {
    expect(normalizeChannelTarget("channel:")).toBeNull();
  });
  it("direct: with empty remainder", () => {
    expect(normalizeChannelTarget("direct:")).toBeNull();
  });
});

// =========================================================================
// buildCanonicalSessionKey
// =========================================================================
describe("buildCanonicalSessionKey", () => {
  it("builds key for direct target", () => {
    expect(buildCanonicalSessionKey("main", "direct:abc")).toBe("agent:main:customchat:group:direct:abc");
  });
  it("builds key for channel target", () => {
    expect(buildCanonicalSessionKey("main", "channel:abc")).toBe("agent:main:customchat:group:direct:abc");
  });
  it("builds key for new group role target", () => {
    expect(buildCanonicalSessionKey("main", "group:direct:abc:role:role-1")).toBe(
      "agent:main:customchat:group:direct:abc:role:role-1",
    );
  });
  it("builds key for non-standard target", () => {
    expect(buildCanonicalSessionKey("main", "something")).toBe("agent:main:customchat:something");
  });
});

// =========================================================================
// normalizeSessionKeyCandidate
// =========================================================================
describe("normalizeSessionKeyCandidate", () => {
  it("returns key starting with agent:", () => {
    expect(normalizeSessionKeyCandidate("agent:main:customchat:group:direct:abc")).toBe("agent:main:customchat:group:direct:abc");
  });
  it("returns null for non-agent key", () => {
    expect(normalizeSessionKeyCandidate("direct:abc")).toBeNull();
  });
  it("returns null for null", () => {
    expect(normalizeSessionKeyCandidate(null)).toBeNull();
  });
  it("returns null for empty", () => {
    expect(normalizeSessionKeyCandidate("")).toBeNull();
  });
});

// =========================================================================
// extractText
// =========================================================================
describe("extractText", () => {
  it("returns string as-is", () => {
    expect(extractText("hello")).toBe("hello");
  });
  it("extracts .text field", () => {
    expect(extractText({ text: "hello" })).toBe("hello");
  });
  it("extracts .caption field", () => {
    expect(extractText({ caption: "caption" })).toBe("caption");
  });
  it("extracts .body field", () => {
    expect(extractText({ body: "body" })).toBe("body");
  });
  it("joins .parts text", () => {
    expect(extractText({ parts: [{ text: "a" }, { text: "b" }] })).toBe("a\nb");
  });
  it("returns empty for null", () => {
    expect(extractText(null)).toBe("");
  });
  it("returns empty for number", () => {
    expect(extractText(42)).toBe("");
  });
});

// =========================================================================
// extractTarget
// =========================================================================
describe("extractTarget", () => {
  it("extracts from string", () => {
    expect(extractTarget("direct:abc")).toBe("direct:abc");
  });
  it("extracts from {target}", () => {
    expect(extractTarget({ target: "panel:abc" })).toBe("direct:abc");
  });
  it("extracts from {to}", () => {
    expect(extractTarget({ to: "channel:abc" })).toBe("direct:abc");
  });
  it("extracts from {meta.target}", () => {
    expect(extractTarget({ meta: { target: "direct:abc" } })).toBe("direct:abc");
  });
  it("extracts from {deliveryContext.to}", () => {
    expect(extractTarget({ deliveryContext: { to: "direct:abc" } })).toBe("direct:abc");
  });
  it("throws for null", () => {
    expect(() => extractTarget(null)).toThrow("customchat target is required");
  });
  it("throws for unnormalizable string", () => {
    expect(() => extractTarget("invalid")).toThrow("customchat target is required");
  });
  it("throws for empty object", () => {
    expect(() => extractTarget({})).toThrow("customchat target is required");
  });
});

// =========================================================================
// extractSessionKeyHint
// =========================================================================
describe("extractSessionKeyHint", () => {
  it("returns string as-is", () => {
    expect(extractSessionKeyHint("agent:main:key")).toBe("agent:main:key");
  });
  it("extracts from .sessionKey", () => {
    expect(extractSessionKeyHint({ sessionKey: "key1" })).toBe("key1");
  });
  it("extracts from .target", () => {
    expect(extractSessionKeyHint({ target: "target1" })).toBe("target1");
  });
  it("falls through to meta", () => {
    expect(extractSessionKeyHint({ meta: { sessionKey: "metaKey" } })).toBe("metaKey");
  });
  it("returns null for null input", () => {
    expect(extractSessionKeyHint(null)).toBeNull();
  });
  it("returns null for empty strings", () => {
    expect(extractSessionKeyHint({ sessionKey: "" })).toBeNull();
  });
});

// =========================================================================
// extractRunId
// =========================================================================
describe("extractRunId", () => {
  it("extracts from .runId", () => {
    expect(extractRunId({ runId: "abc123" })).toBe("abc123");
  });
  it("extracts from .meta.runId", () => {
    expect(extractRunId({ meta: { runId: "meta-run" } })).toBe("meta-run");
  });
  it("extracts from .context.runId", () => {
    expect(extractRunId({ context: { runId: "ctx-run" } })).toBe("ctx-run");
  });
  it("returns null for missing", () => {
    expect(extractRunId({})).toBeNull();
  });
  it("returns null for non-object", () => {
    expect(extractRunId("string")).toBeNull();
  });
  it("returns null for empty runId", () => {
    expect(extractRunId({ runId: "  " })).toBeNull();
  });
});

// =========================================================================
// buildMessageId
// =========================================================================
describe("buildMessageId", () => {
  it("returns existing messageId", () => {
    expect(buildMessageId({ messageId: "msg-123" }, "fallback-uuid")).toBe("msg-123");
  });
  it("returns existing messageId trimmed", () => {
    expect(buildMessageId({ messageId: "  msg-123  " }, "uuid")).toBe("msg-123");
  });
  it("returns customchat:uuid for missing messageId", () => {
    expect(buildMessageId({}, "test-uuid")).toBe("customchat:test-uuid");
  });
  it("returns customchat:uuid for empty messageId", () => {
    expect(buildMessageId({ messageId: "" }, "test-uuid")).toBe("customchat:test-uuid");
  });
  it("returns customchat:uuid for null input", () => {
    expect(buildMessageId(null, "test-uuid")).toBe("customchat:test-uuid");
  });
});

// =========================================================================
// extractTextFromMessagePayload
// =========================================================================
describe("extractTextFromMessagePayload", () => {
  it("returns trimmed string", () => {
    expect(extractTextFromMessagePayload("  hello  ")).toBe("hello");
  });
  it("extracts .text", () => {
    expect(extractTextFromMessagePayload({ text: "msg" })).toBe("msg");
  });
  it("extracts .body", () => {
    expect(extractTextFromMessagePayload({ body: "body" })).toBe("body");
  });
  it("joins .content array", () => {
    const input = { content: [{ text: "a" }, { type: "text", text: "b" }] };
    expect(extractTextFromMessagePayload(input)).toBe("a\nb");
  });
  it("joins .parts array", () => {
    const input = { parts: [{ text: "x" }, { text: "y" }] };
    expect(extractTextFromMessagePayload(input)).toBe("x\ny");
  });
  it("returns empty for null", () => {
    expect(extractTextFromMessagePayload(null)).toBe("");
  });
  it("returns empty for empty object", () => {
    expect(extractTextFromMessagePayload({})).toBe("");
  });
});

// =========================================================================
// extractMessageRole
// =========================================================================
describe("extractMessageRole", () => {
  it("extracts .role", () => {
    expect(extractMessageRole({ role: "assistant" })).toBe("assistant");
  });
  it("extracts .kind as fallback", () => {
    expect(extractMessageRole({ kind: "user" })).toBe("user");
  });
  it("returns empty for missing", () => {
    expect(extractMessageRole({})).toBe("");
  });
  it("returns empty for null", () => {
    expect(extractMessageRole(null)).toBe("");
  });
});

// =========================================================================
// isDeliveryMirrorMessage
// =========================================================================
describe("isDeliveryMirrorMessage", () => {
  it("returns true for exact match", () => {
    expect(isDeliveryMirrorMessage({
      provider: "openclaw",
      model: "delivery-mirror",
      api: "openai-responses",
    })).toBe(true);
  });
  it("returns false for partial match", () => {
    expect(isDeliveryMirrorMessage({
      provider: "openclaw",
      model: "delivery-mirror",
    })).toBe(false);
  });
  it("returns false for null", () => {
    expect(isDeliveryMirrorMessage(null)).toBe(false);
  });
});

// =========================================================================
// summarizeToolArguments
// =========================================================================
describe("summarizeToolArguments", () => {
  it("returns command if present", () => {
    expect(summarizeToolArguments("exec", { command: "ls -la" })).toBe("ls -la");
  });
  it("returns path if no command", () => {
    expect(summarizeToolArguments("read", { path: "/tmp/file" })).toBe("/tmp/file");
  });
  it("returns query", () => {
    expect(summarizeToolArguments("search", { query: "test query" })).toBe("test query");
  });
  it("returns toolName as fallback", () => {
    expect(summarizeToolArguments("unknown", {})).toBe("unknown");
  });
});

// =========================================================================
// extractLatestAssistantText*
// =========================================================================
describe("extractLatestAssistantTextFromMessages", () => {
  it("joins assistant texts", () => {
    const messages = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "hello" },
      { role: "assistant", text: "world" },
    ];
    expect(extractLatestAssistantTextFromMessages(messages)).toBe("hello\n\nworld");
  });
  it("filters delivery mirror messages", () => {
    const messages = [
      { role: "assistant", text: "real", provider: "google", model: "flash", api: "xxx" },
      { role: "assistant", text: "mirror", provider: "openclaw", model: "delivery-mirror", api: "openai-responses" },
    ];
    expect(extractLatestAssistantTextFromMessages(messages)).toBe("real");
  });
  it("returns empty for no assistant messages", () => {
    expect(extractLatestAssistantTextFromMessages([
      { role: "user", text: "hi" },
    ])).toBe("");
  });
  it("returns empty for empty array", () => {
    expect(extractLatestAssistantTextFromMessages([])).toBe("");
  });
});

describe("extractLatestAssistantTextForCurrentTurn", () => {
  it("only takes text after last user message", () => {
    const messages = [
      { role: "assistant", text: "old" },
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
    ];
    expect(extractLatestAssistantTextForCurrentTurn(messages)).toBe("answer");
  });
  it("takes all if no user messages", () => {
    const messages = [
      { role: "assistant", text: "a" },
      { role: "assistant", text: "b" },
    ];
    expect(extractLatestAssistantTextForCurrentTurn(messages)).toBe("a\n\nb");
  });
});

describe("extractLatestAssistantText", () => {
  it("extracts from {messages} array", () => {
    const payload = { messages: [{ role: "assistant", text: "hi" }] };
    expect(extractLatestAssistantText(payload)).toBe("hi");
  });
  it("returns empty for missing messages", () => {
    expect(extractLatestAssistantText({})).toBe("");
  });
});

// =========================================================================
// extractCurrentTurnMessages
// =========================================================================
describe("extractCurrentTurnMessages", () => {
  it("returns messages after last user", () => {
    const messages = [
      { role: "user", text: "q1" },
      { role: "assistant", text: "a1" },
      { role: "user", text: "q2" },
      { role: "assistant", text: "a2" },
    ];
    const result = extractCurrentTurnMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: "a2" });
  });
  it("returns all messages if no user messages", () => {
    const messages = [
      { role: "assistant", text: "a1" },
      { role: "assistant", text: "a2" },
    ];
    expect(extractCurrentTurnMessages(messages)).toBe(messages);
  });
});

// =========================================================================
// Session record helpers
// =========================================================================
describe("looksLikeSessionRecord", () => {
  it("true for {key}", () => expect(looksLikeSessionRecord({ key: "k" })).toBe(true));
  it("true for {sessionKey}", () => expect(looksLikeSessionRecord({ sessionKey: "k" })).toBe(true));
  it("true for {id} with colon", () => expect(looksLikeSessionRecord({ id: "a:b" })).toBe(true));
  it("false for {id} without colon", () => expect(looksLikeSessionRecord({ id: "abc" })).toBe(false));
  it("false for null", () => expect(looksLikeSessionRecord(null)).toBe(false));
  it("false for array", () => expect(looksLikeSessionRecord([])).toBe(false));
});

describe("flattenSessionRecords", () => {
  it("flattens nested objects", () => {
    const payload = {
      sessions: {
        "key1": { key: "agent:main:test", updatedAt: 1000 },
      },
    };
    const result = flattenSessionRecords(payload);
    expect(result.some((r) => r.key === "agent:main:test")).toBe(true);
  });
  it("flattens arrays", () => {
    const payload = [{ key: "k1" }, { key: "k2" }];
    expect(flattenSessionRecords(payload)).toHaveLength(2);
  });
  it("handles depth limit", () => {
    let obj: unknown = { key: "deep" };
    for (let i = 0; i < 7; i++) obj = { child: obj };
    expect(flattenSessionRecords(obj)).toEqual([]);
  });
  it("returns empty for null", () => {
    expect(flattenSessionRecords(null)).toEqual([]);
  });
});

describe("toSessionSnapshot", () => {
  it("extracts key from .key", () => {
    const result = toSessionSnapshot({ key: "agent:main:test", updatedAt: 1000 });
    expect(result?.key).toBe("agent:main:test");
    expect(result?.updatedAtMs).toBe(1000);
  });
  it("extracts key from .sessionKey", () => {
    const result = toSessionSnapshot({ sessionKey: "agent:main:test" });
    expect(result?.key).toBe("agent:main:test");
  });
  it("extracts key from .id with colon", () => {
    const result = toSessionSnapshot({ id: "agent:main:test" });
    expect(result?.key).toBe("agent:main:test");
  });
  it("takes max of timestamp fields", () => {
    const result = toSessionSnapshot({ key: "k", updatedAt: 100, createdAt: 200 });
    expect(result?.updatedAtMs).toBe(200);
  });
  it("returns null for no key", () => {
    expect(toSessionSnapshot({ foo: "bar" })).toBeNull();
  });
  it("returns null for empty key", () => {
    expect(toSessionSnapshot({ key: "  " })).toBeNull();
  });
  it("collects strings", () => {
    const result = toSessionSnapshot({ key: "k", target: "direct:abc" });
    expect(result?.strings).toContain("direct:abc");
  });
});

describe("scoreSessionSnapshot", () => {
  const baseInput = {
    agentId: "main",
    target: "direct:abc",
    expectedSessionKey: "agent:main:customchat:group:direct:abc",
    startedAtMs: 1000000,
  };

  it("gives +140 for exact expectedSessionKey match", () => {
    const snapshot: SessionSnapshot = {
      key: "agent:main:customchat:group:direct:abc",
      updatedAtMs: 0,
      strings: [],
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBeGreaterThanOrEqual(140);
  });

  it("gives +90 for normalized target match", () => {
    const snapshot: SessionSnapshot = {
      key: "other:key",
      updatedAtMs: 0,
      strings: ["agent:main:customchat:group:direct:abc"], // normalizes to direct:abc
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBeGreaterThanOrEqual(90);
  });

  it("gives +35 for agent prefix match", () => {
    const snapshot: SessionSnapshot = {
      key: "agent:main:other",
      updatedAtMs: 0,
      strings: [],
      raw: {},
    };
    const score = scoreSessionSnapshot(snapshot, baseInput);
    expect(score).toBeGreaterThanOrEqual(35);
  });

  it("gives +20 for :customchat: in key", () => {
    const snapshot: SessionSnapshot = {
      key: "other:customchat:something",
      updatedAtMs: 0,
      strings: [],
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBeGreaterThanOrEqual(20);
  });

  it("gives +40 for recent update (within 2s)", () => {
    const snapshot: SessionSnapshot = {
      key: "other",
      updatedAtMs: baseInput.startedAtMs - 1000,
      strings: [],
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBeGreaterThanOrEqual(40);
  });

  it("gives +10 for update within 60s", () => {
    const snapshot: SessionSnapshot = {
      key: "other",
      updatedAtMs: baseInput.startedAtMs - 30000,
      strings: [],
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBe(10);
  });

  it("gives 0 for completely unrelated", () => {
    const snapshot: SessionSnapshot = {
      key: "unrelated",
      updatedAtMs: 0,
      strings: [],
      raw: {},
    };
    expect(scoreSessionSnapshot(snapshot, baseInput)).toBe(0);
  });
});

describe("sessionShowsAbortedLastRun", () => {
  it("returns true when abortedLastRun is true", () => {
    expect(sessionShowsAbortedLastRun({ key: "k", updatedAtMs: 0, strings: [], raw: { abortedLastRun: true } })).toBe(true);
  });
  it("returns false when abortedLastRun is false", () => {
    expect(sessionShowsAbortedLastRun({ key: "k", updatedAtMs: 0, strings: [], raw: { abortedLastRun: false } })).toBe(false);
  });
  it("returns false for null snapshot", () => {
    expect(sessionShowsAbortedLastRun(null)).toBe(false);
  });
});

// =========================================================================
// Gateway wait status
// =========================================================================
describe("parseGatewayWaitStatus", () => {
  it("extracts status", () => {
    expect(parseGatewayWaitStatus({ status: "ok" })).toBe("ok");
  });
  it("returns 'timeout' for missing", () => {
    expect(parseGatewayWaitStatus({})).toBe("timeout");
  });
  it("returns 'timeout' for non-string", () => {
    expect(parseGatewayWaitStatus({ status: 42 })).toBe("timeout");
  });
});

describe("isTerminalGatewayWaitStatus", () => {
  it.each(["ok", "completed", "done", "aborted", "cancelled", "canceled", "error"])(
    "returns true for %s",
    (status) => expect(isTerminalGatewayWaitStatus(status)).toBe(true),
  );
  it("returns false for timeout", () => {
    expect(isTerminalGatewayWaitStatus("timeout")).toBe(false);
  });
  it("returns false for running", () => {
    expect(isTerminalGatewayWaitStatus("running")).toBe(false);
  });
});

// =========================================================================
// Agent record helpers
// =========================================================================
describe("looksLikeAgentRecord", () => {
  it("true for {id}", () => expect(looksLikeAgentRecord({ id: "main" })).toBe(true));
  it("true for {agentId}", () => expect(looksLikeAgentRecord({ agentId: "main" })).toBe(true));
  it("true for {name}", () => expect(looksLikeAgentRecord({ name: "Agent" })).toBe(true));
  it("true for {label}", () => expect(looksLikeAgentRecord({ label: "Agent" })).toBe(true));
  it("false for empty obj", () => expect(looksLikeAgentRecord({})).toBe(false));
  it("false for null", () => expect(looksLikeAgentRecord(null)).toBe(false));
  it("false for array", () => expect(looksLikeAgentRecord([])).toBe(false));
});

describe("flattenAgentRecords", () => {
  it("flattens array", () => {
    const result = flattenAgentRecords([{ id: "a" }, { id: "b" }]);
    expect(result).toHaveLength(2);
  });
  it("finds nested records", () => {
    const result = flattenAgentRecords({ agents: { inner: { id: "nested" } } });
    expect(result.some((r) => r.id === "nested")).toBe(true);
  });
  it("returns empty for null", () => {
    expect(flattenAgentRecords(null)).toEqual([]);
  });
});

describe("toAgentView", () => {
  it("extracts agent from id", () => {
    const result = toAgentView({ id: "main", name: "Main Agent" });
    expect(result).toEqual({
      id: "main",
      name: "Main Agent",
      emoji: null,
      avatarUrl: null,
      theme: null,
    });
  });
  it("extracts agent from agentId", () => {
    const result = toAgentView({ agentId: "test" });
    expect(result?.id).toBe("test");
    expect(result?.name).toBe("test"); // falls back to agentId
  });
  it("extracts emoji and theme from identity", () => {
    const result = toAgentView({
      id: "main",
      identity: { name: "Bot", emoji: "🤖", theme: "dark" },
    });
    expect(result?.name).toBe("Bot");
    expect(result?.emoji).toBe("🤖");
    expect(result?.theme).toBe("dark");
  });
  it("returns null for no agentId", () => {
    expect(toAgentView({})).toBeNull();
  });
  it("returns null for empty id", () => {
    expect(toAgentView({ id: "  " })).toBeNull();
  });
});

// =========================================================================
// parseJsonOutput
// =========================================================================
describe("parseJsonOutput", () => {
  it("parses valid JSON", () => {
    expect(parseJsonOutput('{"a":1}')).toEqual({ a: 1 });
  });
  it("returns null for empty string", () => {
    expect(parseJsonOutput("")).toBeNull();
  });
  it("finds last valid JSON line", () => {
    const input = "some log\nmore log\n{\"found\":true}";
    expect(parseJsonOutput(input)).toEqual({ found: true });
  });
  it("throws for no valid JSON", () => {
    expect(() => parseJsonOutput("not json at all")).toThrow("Unable to parse");
  });
});

// =========================================================================
// readAuthorizationToken
// =========================================================================
describe("readAuthorizationToken", () => {
  it("extracts Bearer token", () => {
    const req = { headers: { authorization: "Bearer abc123" } };
    expect(readAuthorizationToken(req)).toBe("abc123");
  });
  it("extracts x-customchat-token header", () => {
    const req = { headers: { "x-customchat-token": "token456" } };
    expect(readAuthorizationToken(req)).toBe("token456");
  });
  it("prefers Bearer over x-customchat-token", () => {
    const req = { headers: { authorization: "Bearer abc", "x-customchat-token": "xyz" } };
    expect(readAuthorizationToken(req)).toBe("abc");
  });
  it("handles array authorization header", () => {
    const req = { headers: { authorization: ["Bearer abc123", "Bearer other"] } };
    expect(readAuthorizationToken(req)).toBe("abc123");
  });
  it("returns empty for no auth headers", () => {
    const req = { headers: {} };
    expect(readAuthorizationToken(req)).toBe("");
  });
});

// =========================================================================
// buildInboundAgentMessage
// =========================================================================
describe("buildInboundAgentMessage", () => {
  it("returns text only for no files", () => {
    expect(buildInboundAgentMessage("direct:abc", "hello", [], null)).toBe("hello");
  });

  it("returns empty string for no text and no files", () => {
    expect(buildInboundAgentMessage("direct:abc", "", [], null)).toBe("");
  });

  it("includes attachment listing", () => {
    const files = [
      { name: "doc.pdf", mimeType: "application/pdf", path: "/tmp/doc.pdf", size: 1024, extractedText: null },
    ];
    const result = buildInboundAgentMessage("direct:abc", "text", files, "/tmp/manifest.json");
    expect(result).toContain("[customchat attachments]");
    expect(result).toContain("doc.pdf (application/pdf, 1024 bytes)");
    expect(result).toContain("[OpenClaw local files]");
    expect(result).toContain("/tmp/doc.pdf");
    expect(result).toContain("manifest.json: /tmp/manifest.json");
    expect(result).not.toContain("[customchat reply routing]");
  });

  it("includes extracted text for text-like files", () => {
    const files = [
      { name: "notes.txt", mimeType: "text/plain", path: "/tmp/notes.txt", size: 100, extractedText: "file content here" },
    ];
    const result = buildInboundAgentMessage("direct:abc", "", files, null);
    expect(result).toContain("[Extracted text]");
    expect(result).toContain("## File: notes.txt");
    expect(result).toContain("file content here");
  });
});

// =========================================================================
// base64UrlEncode
// =========================================================================
describe("base64UrlEncode", () => {
  it("replaces + with -", () => {
    // Buffer that produces + in base64: 0xfb
    const buf = Buffer.from([0xfb, 0xef]);
    const result = base64UrlEncode(buf);
    expect(result).not.toContain("+");
    expect(result).not.toContain("/");
    expect(result).not.toContain("=");
  });
  it("handles empty buffer", () => {
    expect(base64UrlEncode(Buffer.from([]))).toBe("");
  });
  it("encodes known value", () => {
    const buf = Buffer.from("hello");
    expect(base64UrlEncode(buf)).toBe("aGVsbG8");
  });
});

// =========================================================================
// buildDeviceAuthPayloadV3
// =========================================================================
describe("buildDeviceAuthPayloadV3", () => {
  it("builds pipe-separated payload", () => {
    const result = buildDeviceAuthPayloadV3({
      deviceId: "dev1",
      clientId: "cli",
      clientMode: "cli",
      role: "operator",
      scopes: ["admin", "read"],
      signedAt: 1234567890,
      token: "tok",
      nonce: "nonce1",
      platform: "linux",
      deviceFamily: "desktop",
    });
    expect(result).toBe("v3|dev1|cli|cli|operator|admin,read|1234567890|tok|nonce1|linux|desktop");
  });

  it("sorts and dedupes scopes", () => {
    const result = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["b", "a", "b"],
      signedAt: 0,
      token: "t",
      nonce: "n",
      platform: "p",
    });
    expect(result).toContain("a,b");
  });

  it("handles missing deviceFamily", () => {
    const result = buildDeviceAuthPayloadV3({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: [],
      signedAt: 0,
      token: "t",
      nonce: "n",
      platform: "p",
    });
    expect(result.endsWith("|")).toBe(true); // empty deviceFamily
  });
});

// =========================================================================
// MIME_BY_EXT constant
// =========================================================================
describe("MIME_BY_EXT", () => {
  it("has png mapping", () => expect(MIME_BY_EXT[".png"]).toBe("image/png"));
  it("has pdf mapping", () => expect(MIME_BY_EXT[".pdf"]).toBe("application/pdf"));
  it("has json mapping", () => expect(MIME_BY_EXT[".json"]).toBe("application/json"));
  it("has md mapping", () => expect(MIME_BY_EXT[".md"]).toBe("text/markdown"));
});
