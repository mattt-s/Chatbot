/**
 * @file group-router 群组路由模块的单元测试
 *
 * 覆盖 TEST_PLAN.md：
 * - CASE-ROUTE-001 单角色命中
 * - CASE-ROUTE-002 多角色命中
 * - CASE-ROUTE-006 未 @ 任何角色（用户消息默认转给 Leader）
 * - CASE-ROUTE-008 同一角色重复 @（去重由 parseTrailingMentions 处理）
 *
 * P0 自动化测试点：
 * - 路由命中与去重逻辑
 * - lookupRoleByRunId
 * - markRoleIdle / resetInitializedRoles
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

// Mock store
vi.mock("@/lib/store", () => ({
  appendUserMessage: vi.fn().mockResolvedValue({ id: "msg-1", role: "user", text: "test" }),
  listGroupRoles: vi.fn().mockResolvedValue([]),
  listInProgressGroupPanels: vi.fn().mockResolvedValue([]),
  listPanelMessages: vi.fn().mockResolvedValue([]),
}));

// Mock env
vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    customChatAuthToken: "test-token",
    groupRoleWatchdogIntervalMs: 30_000,
    groupRoleBusyInspectAfterMs: 300_000,
    groupRoleBusyAbortAfterMs: 600_000,
  }),
}));

// Mock logger
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    input: vi.fn(),
    output: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockInspectProviderSession = vi.fn();
const mockAbortProviderRun = vi.fn();
vi.mock("@/lib/customchat-provider", () => ({
  inspectProviderSession: (...args: unknown[]) => mockInspectProviderSession(...args),
  abortProviderRun: (...args: unknown[]) => mockAbortProviderRun(...args),
}));

// Mock bridge server
const mockSendInboundToPlugin = vi.fn();
vi.mock("@/lib/customchat-bridge-server", () => ({
  ensureCustomChatBridgeServer: vi.fn().mockResolvedValue(undefined),
  sendInboundToPlugin: (...args: unknown[]) => mockSendInboundToPlugin(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { StoredGroupRole } from "@/lib/types";

function makeRole(overrides: Partial<StoredGroupRole> & { id: string; title: string }): StoredGroupRole {
  return {
    panelId: "p-grp",
    agentId: "main",
    emoji: null,
    isLeader: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const PM = makeRole({ id: "r-pm", title: "PM", isLeader: true });
const ANALYST = makeRole({ id: "r-analyst", title: "分析师" });
const WRITER = makeRole({ id: "r-writer", title: "撰稿人" });
const ALL_ROLES = [PM, ANALYST, WRITER];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group-router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockInspectProviderSession.mockResolvedValue({ exists: true, terminal: false });
    mockAbortProviderRun.mockResolvedValue({ ok: true });
    mockSendInboundToPlugin.mockResolvedValue({
      runId: `run-${Date.now()}`,
      status: "ok",
    });
  });

  describe("lookupRoleByRunId / markRoleIdle / resetInitializedRoles", () => {
    it("lookupRoleByRunId 默认返回 null", async () => {
      const { lookupRoleByRunId } = await import("@/lib/group-router");
      expect(lookupRoleByRunId("unknown")).toBeNull();
    });

    it("markRoleIdle 不报错", async () => {
      const { markRoleIdle } = await import("@/lib/group-router");
      expect(() => markRoleIdle("p1", "r1")).not.toThrow();
    });

    it("resetInitializedRoles 不报错", async () => {
      const { resetInitializedRoles } = await import("@/lib/group-router");
      expect(() => resetInitializedRoles("p1")).not.toThrow();
    });
  });

  describe("routeMessage", () => {
    it("CASE-ROUTE-001: 单角色命中 — 发送 @分析师 只触发分析师", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "请分析数据\n\n@分析师",
        groupRoles: ALL_ROLES,
      });

      // 应该只 dispatch 一次（给分析师）
      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-analyst",
        }),
      );
    });

    it("CASE-ROUTE-002: 多角色命中 — @分析师 @撰稿人 两者均触发", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "请确认\n\n@分析师 @撰稿人",
        groupRoles: ALL_ROLES,
      });

      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(2);
      const targets = mockSendInboundToPlugin.mock.calls.map(
        (call: unknown[]) => (call[0] as { target: string }).target,
      );
      expect(targets).toContain("group:direct:p-grp:role:r-analyst");
      expect(targets).toContain("group:direct:p-grp:role:r-writer");
    });

    it("CASE-ROUTE-006: 用户消息无 @ 任何角色 — 默认转发给 Leader", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "普通消息不含 @",
        groupRoles: ALL_ROLES,
      });

      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-pm",
        }),
      );
    });

    it("角色回复无 @ — 兜底转发给 Leader", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "group-role",
        senderLabel: "分析师",
        senderGroupRoleId: "r-analyst",
        text: "分析完成，无需 @ 其他人",
        groupRoles: ALL_ROLES,
      });

      // 应该 dispatch 给 PM（Leader）
      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-pm",
        }),
      );
    });

    it("Leader 回复无 @ — 不会自己转发给自己", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "group-role",
        senderLabel: "PM",
        senderGroupRoleId: "r-pm",
        text: "任务分配完毕",
        groupRoles: ALL_ROLES,
      });

      // PM 是 Leader，无 @ 且发送者是 Leader → 不转发
      expect(mockSendInboundToPlugin).not.toHaveBeenCalled();
    });

    it("角色 @ 自己 — 过滤掉自身", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      await routeMessage({
        panelId: "p-grp",
        senderType: "group-role",
        senderLabel: "分析师",
        senderGroupRoleId: "r-analyst",
        text: "分析完成\n\n@分析师 @撰稿人",
        groupRoles: ALL_ROLES,
      });

      // 应该只 dispatch 给撰稿人，不给分析师自己
      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-writer",
        }),
      );
    });

    it("没有启用角色时不触发", async () => {
      const { routeMessage } = await import("@/lib/group-router");
      const disabledRoles = ALL_ROLES.map((r) => ({ ...r, enabled: false }));
      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "请处理\n\n@分析师",
        groupRoles: disabledRoles,
      });

      expect(mockSendInboundToPlugin).not.toHaveBeenCalled();
    });

    it("角色本地卡 busy 但远端已终态时，会先自愈再直接 dispatch", async () => {
      const { routeMessage } = await import("@/lib/group-router");

      vi.useFakeTimers();
      mockSendInboundToPlugin
        .mockResolvedValueOnce({ runId: "run-stuck", status: "ok" })
        .mockResolvedValueOnce({ runId: "run-recovered", status: "ok" });

      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "先让分析师处理\n\n@分析师",
        groupRoles: ALL_ROLES,
      });

      vi.advanceTimersByTime(16_000);
      mockInspectProviderSession.mockResolvedValueOnce({ exists: true, terminal: true });

      await routeMessage({
        panelId: "p-grp",
        senderType: "user",
        senderLabel: "用户",
        text: "继续跟进\n\n@分析师",
        groupRoles: ALL_ROLES,
      });

      expect(mockInspectProviderSession).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(2);
      expect(mockSendInboundToPlugin.mock.calls[1][0]).toMatchObject({
        target: "group:direct:p-grp:role:r-analyst",
      });
      vi.useRealTimers();
    });
  });

  describe("onRoleReplyFinal", () => {
    it("角色回复完成后继续路由 @mention", async () => {
      const { onRoleReplyFinal } = await import("@/lib/group-router");
      await onRoleReplyFinal({
        panelId: "p-grp",
        groupRoleId: "r-analyst",
        runId: "run-analyst-final",
        senderLabel: "分析师",
        replyText: "请继续\n\n@撰稿人",
        groupRoles: ALL_ROLES,
      });

      // 应该 dispatch 给撰稿人
      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-writer",
        }),
      );
    });

    it("回复无 @ 则兜底给 Leader", async () => {
      const { onRoleReplyFinal } = await import("@/lib/group-router");
      await onRoleReplyFinal({
        panelId: "p-grp",
        groupRoleId: "r-analyst",
        runId: "run-analyst-final",
        senderLabel: "分析师",
        replyText: "分析完成",
        groupRoles: ALL_ROLES,
      });

      expect(mockSendInboundToPlugin).toHaveBeenCalledTimes(1);
      expect(mockSendInboundToPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "group:direct:p-grp:role:r-pm",
        }),
      );
    });
  });

  describe("onRoleReplyErrorOrAborted", () => {
    it("角色出错后不报错", async () => {
      const { onRoleReplyErrorOrAborted } = await import("@/lib/group-router");
      await expect(
        onRoleReplyErrorOrAborted({
          panelId: "p-grp",
          groupRoleId: "r-analyst",
          runId: "run-analyst-error",
        }),
      ).resolves.not.toThrow();
    });
  });
});
