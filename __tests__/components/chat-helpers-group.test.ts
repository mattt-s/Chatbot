/**
 * @file chat-helpers 群组相关功能的单元测试
 *
 * 覆盖 TEST_PLAN.md：
 * - matchesPanelSession 群组事件匹配
 * - CASE-MSG-001 群角色回复展示发送者身份
 * - CASE-REG-002 普通 panel 发消息不受影响
 */
import { describe, it, expect } from "vitest";
import { matchesPanelSession } from "@/components/chat-helpers";

describe("matchesPanelSession – 群组面板", () => {
  it("群组面板匹配任何同面板下角色的事件 (group role target)", () => {
    // 事件来自 group:direct:p1:role:role1，归一化后为 panel:p1
    // 群组面板 panelId=p1，应匹配
    expect(
      matchesPanelSession("panel:p1", "panel:p-grp", "group", "p1"),
    ).toBe(true);
  });

  it("群组面板不匹配其他面板的事件", () => {
    expect(
      matchesPanelSession("panel:p2", "panel:p-grp", "group", "p1"),
    ).toBe(false);
  });

  it("群组面板精确匹配也可以", () => {
    expect(
      matchesPanelSession("panel:p-grp", "panel:p-grp", "group", "p-grp"),
    ).toBe(true);
  });

  it("非群组面板不使用群组匹配逻辑 (CASE-REG-002)", () => {
    // direct 面板，panelId=p1
    expect(
      matchesPanelSession("panel:p1", "panel:p1", "direct", "p1"),
    ).toBe(true);

    // direct 面板不应匹配不同 sessionKey
    expect(
      matchesPanelSession("panel:other", "panel:p1", "direct", "p1"),
    ).toBe(false);
  });

  it("不传 panelKind 时退化为原始行为", () => {
    expect(matchesPanelSession("panel:p1", "panel:p1")).toBe(true);
    expect(matchesPanelSession("panel:p2", "panel:p1")).toBe(false);
    expect(matchesPanelSession("channel:p1", "panel:p1")).toBe(true);
  });

  it("null 事件 key 返回 false", () => {
    expect(matchesPanelSession(null, "panel:p1", "group", "p1")).toBe(false);
  });
});
