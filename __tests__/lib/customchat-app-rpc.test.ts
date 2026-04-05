import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockLoadAgentCatalog = vi.fn();
const mockDeleteProviderSession = vi.fn();
const mockSubmitGroupMessage = vi.fn();
const mockResetInitializedRoles = vi.fn();
const mockCreateGroupRole = vi.fn();
const mockCreatePanel = vi.fn();
const mockDeletePanel = vi.fn();
const mockEnsureSeededAdminUser = vi.fn();
const mockFindGroupRoleById = vi.fn();
const mockGetPanelRecordForUser = vi.fn();
const mockListGroupRoles = vi.fn();
const mockListPanelsForUser = vi.fn();
const mockRemoveGroupRole = vi.fn();
const mockSetGroupRoleLeader = vi.fn();
const mockUnsetGroupRoleLeader = vi.fn();
const mockUpdateGroupPanelPlan = vi.fn();
const mockUpdateGroupRole = vi.fn();
const mockClearGroupPanelPlan = vi.fn();

vi.mock("@/lib/agents", () => ({
  loadAgentCatalog: (...args: unknown[]) => mockLoadAgentCatalog(...args),
}));

vi.mock("@/lib/customchat-provider", () => ({
  deleteProviderSession: (...args: unknown[]) => mockDeleteProviderSession(...args),
}));

vi.mock("@/lib/group-message", () => ({
  submitGroupMessage: (...args: unknown[]) => mockSubmitGroupMessage(...args),
}));

vi.mock("@/lib/group-router", () => ({
  resetInitializedRoles: (...args: unknown[]) => mockResetInitializedRoles(...args),
}));

vi.mock("@/lib/store", () => ({
  createGroupRole: (...args: unknown[]) => mockCreateGroupRole(...args),
  createPanel: (...args: unknown[]) => mockCreatePanel(...args),
  deletePanel: (...args: unknown[]) => mockDeletePanel(...args),
  ensureSeededAdminUser: (...args: unknown[]) => mockEnsureSeededAdminUser(...args),
  findGroupRoleById: (...args: unknown[]) => mockFindGroupRoleById(...args),
  getPanelRecordForUser: (...args: unknown[]) => mockGetPanelRecordForUser(...args),
  listGroupRoles: (...args: unknown[]) => mockListGroupRoles(...args),
  listPanelsForUser: (...args: unknown[]) => mockListPanelsForUser(...args),
  removeGroupRole: (...args: unknown[]) => mockRemoveGroupRole(...args),
  setGroupRoleLeader: (...args: unknown[]) => mockSetGroupRoleLeader(...args),
  unsetGroupRoleLeader: (...args: unknown[]) => mockUnsetGroupRoleLeader(...args),
  updateGroupPanelPlan: (...args: unknown[]) => mockUpdateGroupPanelPlan(...args),
  updateGroupRole: (...args: unknown[]) => mockUpdateGroupRole(...args),
  clearGroupPanelPlan: (...args: unknown[]) => mockClearGroupPanelPlan(...args),
}));

describe("dispatchCustomChatAppRpc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockEnsureSeededAdminUser.mockResolvedValue({
      id: "u-admin",
      email: "admin@test.com",
      displayName: "Admin",
    });
    mockLoadAgentCatalog.mockResolvedValue([
      { id: "main", name: "Main", emoji: null, avatarUrl: null, theme: null },
      { id: "pm", name: "PM", emoji: null, avatarUrl: null, theme: null },
    ]);
    mockCreatePanel.mockResolvedValue({
      id: "panel-1",
      userId: "u-admin",
      title: "博客开发群",
      agentId: "",
      kind: "group",
      sessionKey: "panel:panel-1",
      activeRunId: null,
      groupPlan: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockCreateGroupRole.mockImplementation(async (input) => ({
      id: `role-${input.title}`,
      panelId: input.panelId,
      agentId: input.agentId,
      title: input.title,
      emoji: input.emoji ?? null,
      isLeader: input.isLeader ?? false,
      enabled: true,
    }));
    mockGetPanelRecordForUser.mockResolvedValue({
      id: "panel-1",
      userId: "u-admin",
      title: "博客开发群",
      agentId: "",
      kind: "group",
      sessionKey: "panel:panel-1",
      activeRunId: null,
      groupPlan: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockListPanelsForUser.mockResolvedValue([
      {
        id: "panel-1",
        title: "博客开发群",
        agentId: "",
        sessionKey: "panel:panel-1",
        kind: "group",
        taskState: "idle",
        userRoleName: "我",
        assistantRoleName: "助手",
        activeRunId: null,
        messageCount: 0,
        latestMessagePreview: null,
        messagesLoaded: false,
        groupPlan: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messages: [],
        groupRoles: [
          {
            id: "role-pm",
            panelId: "panel-1",
            agentId: "pm",
            title: "PM",
            emoji: null,
            isLeader: true,
            enabled: true,
          },
        ],
      },
    ]);
    mockListGroupRoles.mockResolvedValue([
      {
        id: "role-pm",
        panelId: "panel-1",
        agentId: "pm",
        title: "PM",
        emoji: null,
        isLeader: false,
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    mockFindGroupRoleById.mockResolvedValue({
      id: "role-pm",
      panelId: "panel-1",
      agentId: "pm",
      title: "PM",
      emoji: null,
      isLeader: false,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    mockSetGroupRoleLeader.mockResolvedValue({
      id: "role-pm",
      panelId: "panel-1",
      agentId: "pm",
      title: "PM",
      emoji: null,
      isLeader: true,
      enabled: true,
    });
    mockUnsetGroupRoleLeader.mockResolvedValue({
      id: "role-pm",
      panelId: "panel-1",
      agentId: "pm",
      title: "PM",
      emoji: null,
      isLeader: false,
      enabled: true,
    });
    mockUpdateGroupRole.mockResolvedValue({
      id: "role-pm",
      panelId: "panel-1",
      agentId: "pm",
      title: "产品经理",
      emoji: null,
      isLeader: false,
      enabled: true,
    });
    mockRemoveGroupRole.mockResolvedValue({ ok: true });
    mockDeleteProviderSession.mockResolvedValue({ ok: true });
    mockDeletePanel.mockResolvedValue({ ok: true });
    mockUpdateGroupPanelPlan.mockResolvedValue({
      id: "panel-1",
      title: "博客开发群",
      kind: "group",
      taskState: "in_progress",
      groupPlan: {
        summary: "技术方案已确定，RD 正在接分类标签表单。",
        items: [
          { title: "技术方案确定", status: "done" },
          { title: "分类标签表单接入", status: "in_progress" },
        ],
        updatedAt: "2026-01-01T00:05:00.000Z",
        updatedByLabel: "TeamLead",
      },
    });
    mockClearGroupPanelPlan.mockResolvedValue({
      id: "panel-1",
      title: "博客开发群",
      kind: "group",
      taskState: "idle",
      groupPlan: null,
    });
    mockSubmitGroupMessage.mockResolvedValue({
      userMessage: {
        id: "msg-1",
        role: "user",
        text: "请总结一下当前进展",
        state: "final",
        attachments: [],
        runtimeSteps: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("group.create 创建群组并批量添加角色", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group.create", {
      title: "博客开发群",
      roles: [
        { title: "PM", agentId: "pm", isLeader: true },
        { title: "RD", agentId: "main" },
      ],
    });

    expect(mockCreatePanel).toHaveBeenCalledWith("u-admin", "", "博客开发群", "group");
    expect(mockCreateGroupRole).toHaveBeenCalledTimes(2);
    expect(mockResetInitializedRoles).toHaveBeenCalledWith("panel-1");
    expect(result).toMatchObject({
      ok: true,
      panel: { id: "panel-1", title: "博客开发群" },
      roles: [
        { title: "PM", agentId: "pm", isLeader: true },
        { title: "RD", agentId: "main", isLeader: false },
      ],
    });
  });

  it("group_role.set_leader 默认设置组长，enabled=false 时取消组长", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    await dispatchCustomChatAppRpc("group_role.set_leader", {
      panelTitle: "博客开发群",
      roleTitle: "PM",
    });
    await dispatchCustomChatAppRpc("group_role.set_leader", {
      panelTitle: "博客开发群",
      roleTitle: "PM",
      enabled: false,
    });

    expect(mockSetGroupRoleLeader).toHaveBeenCalledWith("panel-1", "role-pm");
    expect(mockUnsetGroupRoleLeader).toHaveBeenCalledWith("panel-1", "role-pm");
  });

  it("group_role.remove 删除角色后重置群组注入状态并异步清理远端 session", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group_role.remove", {
      panelId: "panel-1",
      roleId: "role-pm",
    });

    expect(mockRemoveGroupRole).toHaveBeenCalledWith("role-pm");
    expect(mockResetInitializedRoles).toHaveBeenCalledWith("panel-1");
    expect(mockDeleteProviderSession).toHaveBeenCalledWith({
      panelId: "panel-1",
      agentId: "pm",
      target: "group:direct:panel-1:role:role-pm",
    });
    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      roleId: "role-pm",
    });
  });

  it("group_role.add 校验未知 agentId", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    await expect(
      dispatchCustomChatAppRpc("group_role.add", {
        panelId: "panel-1",
        title: "QA",
        agentId: "missing-agent",
      }),
    ).rejects.toThrow("Unknown agentId: missing-agent");
  });

  it("group.get 返回群任务状态和成员详情", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group.get", {
      panelTitle: "博客开发群",
    });

    expect(result).toEqual({
      ok: true,
      group: {
        id: "panel-1",
        title: "博客开发群",
        kind: "group",
        taskState: "idle",
        taskStateChangedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        groupRoles: [
          {
            id: "role-pm",
            panelId: "panel-1",
            agentId: "pm",
            title: "PM",
            emoji: null,
            isLeader: false,
            enabled: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        groupPlan: null,
      },
    });
  });

  it("group.delete 删除群并清理群内角色 session", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group.delete", {
      panelId: "panel-1",
    });

    expect(mockDeletePanel).toHaveBeenCalledWith("u-admin", "panel-1");
    expect(mockResetInitializedRoles).toHaveBeenCalledWith("panel-1");
    expect(mockDeleteProviderSession).toHaveBeenCalledWith({
      panelId: "panel-1",
      agentId: "pm",
      target: "group:direct:panel-1:role:role-pm",
    });
    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      title: "博客开发群",
      removedRoleIds: ["role-pm"],
    });
  });

  it("group.message 以用户消息身份把内容投递进群", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group.message", {
      panelTitle: "博客开发群",
      message: "请总结一下当前进展",
    });

    expect(mockSubmitGroupMessage).toHaveBeenCalledWith({
      user: {
        id: "u-admin",
        email: "admin@test.com",
        displayName: "Admin",
      },
      panel: expect.objectContaining({
        id: "panel-1",
        title: "博客开发群",
      }),
      message: "请总结一下当前进展",
      files: [],
    });
    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      title: "博客开发群",
      taskState: "idle",
      userMessage: {
        id: "msg-1",
        role: "user",
        text: "请总结一下当前进展",
        state: "final",
        attachments: [],
        runtimeSteps: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("group_plan.get 返回当前群 plan 和任务状态", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group_plan.get", {
      panelTitle: "博客开发群",
    });

    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      title: "博客开发群",
      taskState: "idle",
      groupPlan: null,
    });
  });

  it("group_plan.update 写入群 plan", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group_plan.update", {
      panelTitle: "博客开发群",
      updatedByLabel: "TeamLead",
      summary: "技术方案已确定，RD 正在接分类标签表单。",
      items: [
        { title: "技术方案确定", status: "done" },
        { title: "分类标签表单接入", status: "in_progress" },
      ],
    });

    expect(mockUpdateGroupPanelPlan).toHaveBeenCalledWith("panel-1", {
      summary: "技术方案已确定，RD 正在接分类标签表单。",
      items: [
        { title: "技术方案确定", status: "done" },
        { title: "分类标签表单接入", status: "in_progress" },
      ],
      updatedByLabel: "TeamLead",
    });
    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      title: "博客开发群",
      taskState: "in_progress",
      groupPlan: {
        summary: "技术方案已确定，RD 正在接分类标签表单。",
        items: [
          { title: "技术方案确定", status: "done" },
          { title: "分类标签表单接入", status: "in_progress" },
        ],
        updatedAt: "2026-01-01T00:05:00.000Z",
        updatedByLabel: "TeamLead",
      },
    });
  });

  it("group_plan.clear 清空群 plan", async () => {
    const { dispatchCustomChatAppRpc } = await import("@/lib/customchat-app-rpc");

    const result = await dispatchCustomChatAppRpc("group_plan.clear", {
      panelId: "panel-1",
    });

    expect(mockClearGroupPanelPlan).toHaveBeenCalledWith("panel-1");
    expect(result).toEqual({
      ok: true,
      panelId: "panel-1",
      title: "博客开发群",
      taskState: "idle",
      groupPlan: null,
    });
  });
});
