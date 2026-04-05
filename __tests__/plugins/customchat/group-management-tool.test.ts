import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendPortalAppRpc = vi.fn();

vi.mock("@/plugins/customchat/plugin-runtime", () => ({
  sendPortalAppRpc: (...args: unknown[]) => mockSendPortalAppRpc(...args),
}));

describe("registerCustomChatGroupManagementTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSendPortalAppRpc.mockResolvedValue({ ok: true });
  });

  it("注册 manage_group 并把 create_group action 翻译成 group.create app_rpc", async () => {
    const { registerCustomChatGroupManagementTool } = await import(
      "@/plugins/customchat/group-management-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupManagementTool({ registerTool });

    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0][0];
    const result = await tool.execute("call-1", {
      action: "create_group",
      title: "博客开发群",
      roles: [{ title: "PM", agentId: "main", isLeader: true }],
    });

    expect(mockSendPortalAppRpc).toHaveBeenCalledWith("group.create", {
      title: "博客开发群",
      roles: [{ title: "PM", agentId: "main", isLeader: true }],
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true }, null, 2),
        },
      ],
      details: { ok: true },
    });
  });

  it("把 set_group_leader action 翻译成 group_role.set_leader app_rpc", async () => {
    const { registerCustomChatGroupManagementTool } = await import(
      "@/plugins/customchat/group-management-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupManagementTool({ registerTool });

    const tool = registerTool.mock.calls[0][0];
    await tool.execute("call-2", {
      action: "set_group_leader",
      panelTitle: "博客开发群",
      roleTitle: "PM",
    });

    expect(mockSendPortalAppRpc).toHaveBeenCalledWith("group_role.set_leader", {
      panelId: "",
      panelTitle: "博客开发群",
      roleId: "",
      roleTitle: "PM",
      enabled: true,
    });
  });

  it("把 delete_group action 翻译成 group.delete app_rpc", async () => {
    const { registerCustomChatGroupManagementTool } = await import(
      "@/plugins/customchat/group-management-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupManagementTool({ registerTool });

    const tool = registerTool.mock.calls[0][0];
    await tool.execute("call-3", {
      action: "delete_group",
      panelId: "panel-1",
    });

    expect(mockSendPortalAppRpc).toHaveBeenCalledWith("group.delete", {
      panelId: "panel-1",
      panelTitle: "",
    });
  });

  it("把 get_group_task_state 和 send_group_message 翻译成对应 app_rpc", async () => {
    const { registerCustomChatGroupManagementTool } = await import(
      "@/plugins/customchat/group-management-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupManagementTool({ registerTool });

    const tool = registerTool.mock.calls[0][0];
    await tool.execute("call-4", {
      action: "get_group_task_state",
      panelTitle: "博客开发群",
    });
    await tool.execute("call-5", {
      action: "send_group_message",
      panelTitle: "博客开发群",
      message: "请同步一下最新进展",
    });

    expect(mockSendPortalAppRpc).toHaveBeenNthCalledWith(1, "group.get", {
      panelId: "",
      panelTitle: "博客开发群",
    });
    expect(mockSendPortalAppRpc).toHaveBeenNthCalledWith(2, "group.message", {
      panelId: "",
      panelTitle: "博客开发群",
      message: "请同步一下最新进展",
    });
  });
});
