/**
 * @file mention-parser 单元测试
 */
import { describe, expect, it } from "vitest";

import {
  buildDispatchMessage,
  escapeRegExp,
  extractInstructionText,
  parseTrailingMentions,
} from "@/lib/mention-parser";
import type { StoredGroupRole } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRole(overrides: Partial<StoredGroupRole> & { id: string; title: string }): StoredGroupRole {
  return {
    panelId: "p1",
    agentId: "main",
    emoji: null,
    isLeader: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const PM = makeRole({ id: "r1", title: "PM", isLeader: true });
const ANALYST = makeRole({ id: "r2", title: "分析师" });
const WRITER = makeRole({ id: "r3", title: "撰稿人" });
const ALL_ROLES = [PM, ANALYST, WRITER];

// ---------------------------------------------------------------------------
// escapeRegExp
// ---------------------------------------------------------------------------

describe("escapeRegExp", () => {
  it("escapes special regex characters", () => {
    expect(escapeRegExp("hello.world")).toBe("hello\\.world");
    expect(escapeRegExp("a+b*c")).toBe("a\\+b\\*c");
    expect(escapeRegExp("no specials")).toBe("no specials");
  });
});

// ---------------------------------------------------------------------------
// parseTrailingMentions
// ---------------------------------------------------------------------------

describe("parseTrailingMentions", () => {
  it("returns empty array for text without @mentions", () => {
    expect(parseTrailingMentions("hello world", ALL_ROLES)).toEqual([]);
  });

  it("parses single @mention at end", () => {
    const result = parseTrailingMentions("请帮我做\n\n@PM", ALL_ROLES);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r1");
  });

  it("parses multiple @mentions at end", () => {
    const result = parseTrailingMentions("分工如下\n\n@分析师 @撰稿人", ALL_ROLES);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(["r2", "r3"]);
  });

  it("only checks last 3 lines", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4 @PM\nLine 5\n\n@分析师";
    const result = parseTrailingMentions(text, ALL_ROLES);
    // @PM is outside last 3 lines, only @分析师 should match
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r2");
  });

  it("ignores disabled roles", () => {
    const disabledPM = { ...PM, enabled: false };
    const result = parseTrailingMentions("test\n\n@PM", [disabledPM, ANALYST]);
    expect(result).toHaveLength(0);
  });

  it("handles @mentions with trailing whitespace", () => {
    const result = parseTrailingMentions("done\n\n@PM  ", ALL_ROLES);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("r1");
  });

  it("does not treat sentence-leading mentions in the last line as routing targets", () => {
    const result = parseTrailingMentions("@PM 请把任务转给分析师", ALL_ROLES);
    expect(result).toEqual([]);
  });

  it("only parses trailing mention-only lines", () => {
    const result = parseTrailingMentions("这是回复正文\n@PM @分析师", ALL_ROLES);
    expect(result.map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });

  it("matches longer names first to avoid ambiguity", () => {
    const shortName = makeRole({ id: "r4", title: "分析" });
    const longName = makeRole({ id: "r5", title: "分析师" });
    const result = parseTrailingMentions("test\n\n@分析师", [shortName, longName]);
    expect(result.some((r) => r.id === "r5")).toBe(true);
  });

  it("parses mentions from footer block even when task marker appears after mentions", () => {
    const result = parseTrailingMentions(
      "请两位立即回传可执行方案：\n\n@分析师\n@撰稿人\n\n[TASK_IN_PROGRESS]",
      ALL_ROLES,
    );

    expect(result.map((r) => r.id)).toEqual(["r2", "r3"]);
  });

  it("parses mentions from footer block even when task marker appears before mentions", () => {
    const result = parseTrailingMentions(
      "继续推进\n\n[TASK_IN_PROGRESS]\n@分析师 @撰稿人",
      ALL_ROLES,
    );

    expect(result.map((r) => r.id)).toEqual(["r2", "r3"]);
  });
});

// ---------------------------------------------------------------------------
// extractInstructionText
// ---------------------------------------------------------------------------

describe("extractInstructionText", () => {
  it("removes trailing @mention lines", () => {
    const text = "请帮我做报告\n\n@PM";
    expect(extractInstructionText(text)).toBe("请帮我做报告");
  });

  it("removes multiple trailing @mention lines", () => {
    const text = "分工安排\n\n@分析师 @撰稿人\n";
    expect(extractInstructionText(text)).toBe("分工安排");
  });

  it("removes trailing mention-only lines with role context", () => {
    const text = "收到，马上处理\n@PM @分析师";
    expect(extractInstructionText(text, ALL_ROLES)).toBe("收到，马上处理");
  });

  it("removes trailing empty lines along with @mentions", () => {
    const text = "正文内容\n\n\n@PM\n\n";
    expect(extractInstructionText(text)).toBe("正文内容");
  });

  it("preserves text when no @mentions at end", () => {
    const text = "没有@人的正文";
    expect(extractInstructionText(text)).toBe("没有@人的正文");
  });

  it("preserves @mentions in middle of text", () => {
    const text = "我告诉@PM这件事\n然后继续";
    expect(extractInstructionText(text)).toBe("我告诉@PM这件事\n然后继续");
  });

  it("removes trailing footer block containing both mentions and task marker", () => {
    const text = [
      "slug 唯一，公开路由 /p/{slug}",
      "请两位立即回传可执行方案：",
      "",
      "@分析师",
      "@撰稿人",
      "",
      "[TASK_IN_PROGRESS]",
    ].join("\n");

    expect(extractInstructionText(text, ALL_ROLES)).toBe(
      "slug 唯一，公开路由 /p/{slug}\n请两位立即回传可执行方案：",
    );
  });
});

// ---------------------------------------------------------------------------
// buildDispatchMessage
// ---------------------------------------------------------------------------

describe("buildDispatchMessage", () => {
  it("includes group context on first call", () => {
    const result = buildDispatchMessage({
      targetRole: ANALYST,
      allRoles: ALL_ROLES,
      sender: { type: "user", name: "Alice" },
      instruction: "收集数据",
      isFirstCall: true,
    });

    expect(result).toContain("[群组信息]");
    expect(result).toContain("分析师");
    expect(result).toContain("[消息规则]");
    expect(result).toContain("[来自 用户]:");
    expect(result).toContain("收集数据");
    // Should mention other roles
    expect(result).toContain("PM（组长）");
    expect(result).toContain("撰稿人");
    // Should NOT include leader responsibilities for non-leader
    expect(result).not.toContain("[组长职责]");
  });

  it("includes leader responsibilities for leader role", () => {
    const result = buildDispatchMessage({
      targetRole: PM,
      allRoles: ALL_ROLES,
      sender: { type: "user", name: "Alice" },
      instruction: "做个报告",
      isFirstCall: true,
    });

    expect(result).toContain("[组长职责]");
    expect(result).toContain("你是本群组的组长");
  });

  it("omits group context on subsequent calls", () => {
    const result = buildDispatchMessage({
      targetRole: ANALYST,
      allRoles: ALL_ROLES,
      sender: { type: "group-role", name: "PM" },
      instruction: "继续工作",
      isFirstCall: false,
    });

    expect(result).not.toContain("[群组信息]");
    expect(result).not.toContain("[消息规则]");
    expect(result).toContain("[来自 PM]:");
    expect(result).toContain("继续工作");
  });

  it("uses '用户' label for user sender type", () => {
    const result = buildDispatchMessage({
      targetRole: PM,
      allRoles: ALL_ROLES,
      sender: { type: "user", name: "Bob" },
      instruction: "hello",
      isFirstCall: false,
    });

    expect(result).toContain("[来自 用户]:");
  });
});
