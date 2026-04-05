import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSendPortalAppRpc = vi.fn();

vi.mock("@/plugins/customchat/plugin-runtime", () => ({
  sendPortalAppRpc: (...args: unknown[]) => mockSendPortalAppRpc(...args),
}));

describe("registerCustomChatGroupPlanTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSendPortalAppRpc.mockResolvedValue({ ok: true });
  });

  it("把 get_plan action 翻译成 group_plan.get app_rpc", async () => {
    const { registerCustomChatGroupPlanTool } = await import(
      "@/plugins/customchat/group-plan-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupPlanTool({ registerTool });

    const tool = registerTool.mock.calls[0][0];
    await tool.execute("call-1", {
      action: "get_plan",
      panelTitle: "博客开发群",
    });

    expect(mockSendPortalAppRpc).toHaveBeenCalledWith("group_plan.get", {
      panelId: "",
      panelTitle: "博客开发群",
    });
  });

  it("把 update_plan 和 clear_plan 翻译成对应 app_rpc", async () => {
    const { registerCustomChatGroupPlanTool } = await import(
      "@/plugins/customchat/group-plan-tool"
    );
    const registerTool = vi.fn();

    registerCustomChatGroupPlanTool({ registerTool });

    const tool = registerTool.mock.calls[0][0];
    await tool.execute("call-2", {
      action: "update_plan",
      panelTitle: "博客开发群",
      updatedByLabel: "TeamLead",
      summary: "已完成路由设计。",
      items: [
        { title: "路由设计", status: "done" },
        { title: "表单接入", status: "in_progress" },
      ],
    });
    await tool.execute("call-3", {
      action: "clear_plan",
      panelId: "panel-1",
    });

    expect(mockSendPortalAppRpc).toHaveBeenNthCalledWith(1, "group_plan.update", {
      panelId: "",
      panelTitle: "博客开发群",
      summary: "已完成路由设计。",
      updatedByLabel: "TeamLead",
      items: [
        { title: "路由设计", status: "done" },
        { title: "表单接入", status: "in_progress" },
      ],
    });
    expect(mockSendPortalAppRpc).toHaveBeenNthCalledWith(2, "group_plan.clear", {
      panelId: "panel-1",
      panelTitle: "",
    });
  });
});
