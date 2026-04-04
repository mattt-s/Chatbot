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
});
