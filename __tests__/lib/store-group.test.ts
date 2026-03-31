/**
 * @file 群组角色相关 store 函数的单元测试
 *
 * 覆盖 TEST_PLAN.md 中的以下测试用例：
 * - CASE-GRP-001 创建群组成功
 * - CASE-GRP-002 群组名称为空（API 层校验，store 层不涉及）
 * - CASE-GRP-ROLE-001 添加角色成功
 * - CASE-GRP-ROLE-002 角色名称为空（API 层校验）
 * - CASE-MGMT-002 移除角色成功
 * - CASE-MGMT-003 移除后旧消息保留
 * - CASE-REG-001 普通角色 panel 创建不受影响
 *
 * P0 自动化测试点：
 * - 群组角色创建/移除 store 测试
 * - 群组视图组装函数测试
 * - 群消息 sender/target 映射（upsertAssistantMessage 群组字段）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppData } from "@/lib/types";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const mockFs = {
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
};
vi.mock("node:fs/promises", () => ({ default: mockFs, ...mockFs }));

vi.mock("@/lib/env", () => ({
  getStorageDir: () => "/tmp/test-storage",
  getUploadDir: () => "/tmp/test-storage/uploads",
  getDownloadDir: () => "/tmp/test-storage/downloads",
  getDataFilePath: () => "/tmp/test-storage/app-data.json",
  getEnv: () => ({
    adminEmail: "admin@test.com",
    adminPassword: "TestPass123",
    adminName: "Test Admin",
  }),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function emptyData(): AppData {
  return { users: [], panels: [], messages: [], groupRoles: [] };
}

function seedGroupData(): AppData {
  return {
    users: [
      {
        id: "u1",
        email: "admin@test.com",
        displayName: "Admin",
        passwordHash: "$2a$10$fakehash",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    panels: [
      {
        id: "p-direct",
        userId: "u1",
        agentId: "main",
        title: "Direct Panel",
        sessionKey: "panel:p-direct",
        kind: "direct",
        activeRunId: null,
        blockedRunIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "p-grp",
        userId: "u1",
        agentId: "",
        title: "群组 A",
        sessionKey: "panel:p-grp",
        kind: "group",
        activeRunId: null,
        blockedRunIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    messages: [
      {
        id: "m-direct",
        panelId: "p-direct",
        role: "user",
        text: "hello direct",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments: [],
        runId: null,
        state: null,
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
      },
      {
        id: "m-grp-1",
        panelId: "p-grp",
        role: "user",
        text: "hello group @分析师",
        createdAt: "2026-01-01T00:00:00.000Z",
        attachments: [],
        runId: null,
        state: null,
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
      },
      {
        id: "m-grp-2",
        panelId: "p-grp",
        role: "assistant",
        text: "已收到任务",
        createdAt: "2026-01-01T00:01:00.000Z",
        attachments: [],
        runId: "run-grp-1",
        state: "final",
        draft: false,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
        groupRoleId: "role-analyst",
        senderLabel: "分析师",
        mentionedGroupRoleIds: [],
      },
    ],
    groupRoles: [
      {
        id: "role-analyst",
        panelId: "p-grp",
        agentId: "main",
        title: "分析师",
        emoji: null,
        isLeader: false,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "role-writer",
        panelId: "p-grp",
        agentId: "main",
        title: "撰稿人",
        emoji: "✍️",
        isLeader: true,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function setMockData(data: AppData) {
  mockFs.readFile.mockResolvedValue(JSON.stringify(data));
}

function getWrittenData(): AppData {
  const calls = mockFs.writeFile.mock.calls;
  const lastCall = calls[calls.length - 1];
  return JSON.parse(lastCall[1] as string) as AppData;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("store – 群组功能", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    setMockData(emptyData());
  });

  // =========================================================================
  // 5.1 群组创建 (CASE-GRP-001)
  // =========================================================================

  describe("createPanel with kind='group'", () => {
    it("创建群组面板成功，kind 为 group，agentId 为空", async () => {
      setMockData(seedGroupData());
      const { createPanel } = await import("@/lib/store");
      const panel = await createPanel("u1", "", "新群组", "group");
      expect(panel.kind).toBe("group");
      expect(panel.agentId).toBe("");
      expect(panel.title).toBe("新群组");
      expect(panel.messageCount).toBe(0);
      expect(panel.groupRoles).toEqual([]);
    });

    it("创建普通面板不受群组影响 (CASE-REG-001)", async () => {
      setMockData(seedGroupData());
      const { createPanel } = await import("@/lib/store");
      const panel = await createPanel("u1", "main", "Direct Role");
      expect(panel.kind).toBe("direct");
      expect(panel.agentId).toBe("main");
    });

    it("默认 kind 为 direct", async () => {
      setMockData(seedGroupData());
      const { createPanel } = await import("@/lib/store");
      const panel = await createPanel("u1", "main", "Default Kind");
      expect(panel.kind).toBe("direct");
    });
  });

  // =========================================================================
  // 群组面板视图包含 groupRoles
  // =========================================================================

  describe("panelToView / listPanelsForUser 群组视图组装", () => {
    it("群组面板视图包含 groupRoles 列表", async () => {
      setMockData(seedGroupData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1");
      const grpPanel = panels.find((p) => p.id === "p-grp");
      expect(grpPanel).toBeDefined();
      expect(grpPanel!.kind).toBe("group");
      expect(grpPanel!.groupRoles).toHaveLength(2);
      expect(grpPanel!.groupRoles![0].title).toBe("分析师");
      expect(grpPanel!.groupRoles![1].title).toBe("撰稿人");
      expect(grpPanel!.groupRoles![1].isLeader).toBe(true);
    });

    it("直接面板视图的 groupRoles 为 undefined", async () => {
      setMockData(seedGroupData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1");
      const directPanel = panels.find((p) => p.id === "p-direct");
      expect(directPanel).toBeDefined();
      expect(directPanel!.kind).toBe("direct");
      // 直接面板不填充 groupRoles
      expect(directPanel!.groupRoles).toBeUndefined();
    });

    it("群组面板视图中消息包含 groupRoleId 和 senderLabel", async () => {
      setMockData(seedGroupData());
      const { listPanelsForUser } = await import("@/lib/store");
      const panels = await listPanelsForUser("u1");
      const grpPanel = panels.find((p) => p.id === "p-grp");
      const assistantMsg = grpPanel!.messages.find((m) => m.role === "assistant");
      expect(assistantMsg).toBeDefined();
      expect(assistantMsg!.groupRoleId).toBe("role-analyst");
      expect(assistantMsg!.senderLabel).toBe("分析师");
    });
  });

  // =========================================================================
  // 5.2 群组内添加角色 (CASE-GRP-ROLE-001)
  // =========================================================================

  describe("createGroupRole", () => {
    it("创建群组角色成功", async () => {
      setMockData(seedGroupData());
      const { createGroupRole } = await import("@/lib/store");
      const role = await createGroupRole({
        panelId: "p-grp",
        agentId: "coding",
        title: "工程师",
        emoji: "👨‍💻",
      });
      expect(role.title).toBe("工程师");
      expect(role.agentId).toBe("coding");
      expect(role.emoji).toBe("👨‍💻");
      expect(role.isLeader).toBe(false);
      expect(role.enabled).toBe(true);
      expect(role.panelId).toBe("p-grp");

      const written = getWrittenData();
      expect(written.groupRoles).toHaveLength(3);
    });

    it("不存在的面板抛出错误", async () => {
      setMockData(seedGroupData());
      const { createGroupRole } = await import("@/lib/store");
      await expect(
        createGroupRole({ panelId: "nonexistent", agentId: "main", title: "test" }),
      ).rejects.toThrow("Panel not found");
    });

    it("新角色设为 Leader 时取消旧 Leader", async () => {
      setMockData(seedGroupData());
      const { createGroupRole } = await import("@/lib/store");
      const role = await createGroupRole({
        panelId: "p-grp",
        agentId: "main",
        title: "新组长",
        isLeader: true,
      });
      expect(role.isLeader).toBe(true);

      const written = getWrittenData();
      const oldWriter = written.groupRoles.find((r) => r.id === "role-writer");
      expect(oldWriter!.isLeader).toBe(false); // 旧 Leader 被取消
    });
  });

  // =========================================================================
  // 5.4 角色管理 (CASE-MGMT-002, CASE-MGMT-003)
  // =========================================================================

  describe("updateGroupRole", () => {
    it("更新角色名称和 emoji", async () => {
      setMockData(seedGroupData());
      const { updateGroupRole } = await import("@/lib/store");
      const role = await updateGroupRole("role-analyst", {
        title: "高级分析师",
        emoji: "📊",
      });
      expect(role.title).toBe("高级分析师");
      expect(role.emoji).toBe("📊");
    });

    it("更新不存在的角色抛出错误", async () => {
      setMockData(seedGroupData());
      const { updateGroupRole } = await import("@/lib/store");
      await expect(
        updateGroupRole("nonexistent", { title: "test" }),
      ).rejects.toThrow("Group role not found");
    });

    it("禁用角色 (soft delete)", async () => {
      setMockData(seedGroupData());
      const { updateGroupRole } = await import("@/lib/store");
      const role = await updateGroupRole("role-analyst", { enabled: false });
      expect(role.enabled).toBe(false);
    });
  });

  describe("removeGroupRole", () => {
    it("删除角色成功 (CASE-MGMT-002)", async () => {
      setMockData(seedGroupData());
      const { removeGroupRole } = await import("@/lib/store");
      const result = await removeGroupRole("role-analyst");
      expect(result.ok).toBe(true);

      const written = getWrittenData();
      expect(written.groupRoles).toHaveLength(1);
      expect(written.groupRoles[0].id).toBe("role-writer");
    });

    it("删除不存在的角色抛出错误", async () => {
      setMockData(seedGroupData());
      const { removeGroupRole } = await import("@/lib/store");
      await expect(removeGroupRole("nonexistent")).rejects.toThrow("Group role not found");
    });

    it("删除角色后历史消息保留 (CASE-MGMT-003)", async () => {
      setMockData(seedGroupData());
      const { removeGroupRole } = await import("@/lib/store");
      await removeGroupRole("role-analyst");

      const written = getWrittenData();
      // 分析师的历史消息 m-grp-2 仍然存在
      const grpMessages = written.messages.filter((m) => m.panelId === "p-grp");
      expect(grpMessages).toHaveLength(2);
      const analystMsg = grpMessages.find((m) => m.groupRoleId === "role-analyst");
      expect(analystMsg).toBeDefined();
      expect(analystMsg!.text).toBe("已收到任务");
    });
  });

  // =========================================================================
  // Leader 管理
  // =========================================================================

  describe("setGroupRoleLeader / unsetGroupRoleLeader", () => {
    it("设置 Leader 并取消旧 Leader", async () => {
      setMockData(seedGroupData());
      const { setGroupRoleLeader } = await import("@/lib/store");
      const role = await setGroupRoleLeader("p-grp", "role-analyst");
      expect(role.isLeader).toBe(true);

      const written = getWrittenData();
      const oldWriter = written.groupRoles.find((r) => r.id === "role-writer");
      expect(oldWriter!.isLeader).toBe(false);
    });

    it("对不存在的角色设置 Leader 抛错", async () => {
      setMockData(seedGroupData());
      const { setGroupRoleLeader } = await import("@/lib/store");
      await expect(
        setGroupRoleLeader("p-grp", "nonexistent"),
      ).rejects.toThrow("Group role not found");
    });

    it("取消 Leader", async () => {
      setMockData(seedGroupData());
      const { unsetGroupRoleLeader } = await import("@/lib/store");
      const role = await unsetGroupRoleLeader("p-grp", "role-writer");
      expect(role.isLeader).toBe(false);
    });
  });

  // =========================================================================
  // listGroupRoles / findGroupRoleById
  // =========================================================================

  describe("listGroupRoles", () => {
    it("列出指定面板的所有角色", async () => {
      setMockData(seedGroupData());
      const { listGroupRoles } = await import("@/lib/store");
      const roles = await listGroupRoles("p-grp");
      expect(roles).toHaveLength(2);
    });

    it("不存在的面板返回空数组", async () => {
      setMockData(seedGroupData());
      const { listGroupRoles } = await import("@/lib/store");
      const roles = await listGroupRoles("nonexistent");
      expect(roles).toHaveLength(0);
    });
  });

  describe("findGroupRoleById", () => {
    it("按 ID 查找角色", async () => {
      setMockData(seedGroupData());
      const { findGroupRoleById } = await import("@/lib/store");
      const role = await findGroupRoleById("role-analyst");
      expect(role).not.toBeNull();
      expect(role!.title).toBe("分析师");
    });

    it("不存在的 ID 返回 null", async () => {
      setMockData(seedGroupData());
      const { findGroupRoleById } = await import("@/lib/store");
      const role = await findGroupRoleById("nonexistent");
      expect(role).toBeNull();
    });
  });

  // =========================================================================
  // 删除群组面板时清理 groupRoles
  // =========================================================================

  describe("deletePanel 群组面板", () => {
    it("删除群组面板同时清理该面板下的 groupRoles", async () => {
      setMockData(seedGroupData());
      const { deletePanel } = await import("@/lib/store");
      await deletePanel("u1", "p-grp");

      const written = getWrittenData();
      expect(written.panels.find((p) => p.id === "p-grp")).toBeUndefined();
      expect(written.groupRoles.filter((r) => r.panelId === "p-grp")).toHaveLength(0);
      // 群组消息也应该被清理
      expect(written.messages.filter((m) => m.panelId === "p-grp")).toHaveLength(0);
    });

    it("删除普通面板不影响群组角色", async () => {
      setMockData(seedGroupData());
      const { deletePanel } = await import("@/lib/store");
      await deletePanel("u1", "p-direct");

      const written = getWrittenData();
      expect(written.groupRoles).toHaveLength(2); // 群组角色不受影响
    });
  });

  // =========================================================================
  // upsertAssistantMessage 群组字段 (CASE-MSG-001)
  // =========================================================================

  describe("upsertAssistantMessage 群组字段", () => {
    it("创建带 groupRoleId/senderLabel/mentionedGroupRoleIds 的消息", async () => {
      setMockData(seedGroupData());
      const { upsertAssistantMessage } = await import("@/lib/store");
      const view = await upsertAssistantMessage("p-grp", {
        runId: "run-new",
        text: "分析完成 @撰稿人",
        state: "final",
        draft: false,
        seq: 1,
        groupRoleId: "role-analyst",
        senderLabel: "分析师",
        mentionedGroupRoleIds: ["role-writer"],
      });
      expect(view).not.toBeNull();
      expect(view!.groupRoleId).toBe("role-analyst");
      expect(view!.senderLabel).toBe("分析师");
      expect(view!.mentionedGroupRoleIds).toEqual(["role-writer"]);
    });

    it("更新消息时保留群组字段", async () => {
      const data = seedGroupData();
      // 先插入一条 delta 消息
      data.messages.push({
        id: "m-delta",
        panelId: "p-grp",
        role: "assistant",
        text: "思考中...",
        createdAt: "2026-01-01T00:02:00.000Z",
        attachments: [],
        runId: "run-update",
        state: "delta",
        draft: true,
        errorMessage: null,
        stopReason: null,
        usage: null,
        runtimeSteps: [],
        groupRoleId: "role-writer",
        senderLabel: "撰稿人",
        eventSeq: 1,
      });
      setMockData(data);
      const { upsertAssistantMessage } = await import("@/lib/store");
      const view = await upsertAssistantMessage("p-grp", {
        runId: "run-update",
        text: "已完成撰写",
        state: "final",
        draft: false,
        seq: 2,
      });
      expect(view!.text).toBe("已完成撰写");
      // 群组字段仍保留
      expect(view!.groupRoleId).toBe("role-writer");
      expect(view!.senderLabel).toBe("撰稿人");
    });
  });

  // =========================================================================
  // 数据兼容性：缺少 groupRoles 字段不报错
  // =========================================================================

  describe("数据兼容性", () => {
    it("读取缺少 groupRoles 字段的旧数据不报错", async () => {
      // 模拟旧版数据，没有 groupRoles 字段
      const oldData = {
        users: [],
        panels: [],
        messages: [],
        // 无 groupRoles
      };
      mockFs.readFile.mockResolvedValue(JSON.stringify(oldData));
      const { listPanelsForUser } = await import("@/lib/store");
      // 不应抛错
      const panels = await listPanelsForUser("u1");
      expect(panels).toHaveLength(0);
    });
  });
});
