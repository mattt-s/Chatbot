import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc, getRunIdByToolCallId } from "./plugin-runtime.js";

const GROUP_ROUTE_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    panelId: {
      type: "string",
      description: "当前群组面板 ID。",
    },
    targets: {
      type: "array",
      description:
        "下一跳角色名列表（使用角色的 title，如 rd、ui、techlead）。传空数组表示本轮对话在此终止，不再转发给任何人。",
      items: { type: "string" },
    },
    taskState: {
      type: "string",
      enum: [
        "idle",
        "in_progress",
        "waiting_input",
        "blocked",
        "pending_review",
        "completed",
      ],
      description:
        "当前群任务状态。仅 leader 需要传此字段；普通成员不传。不确定时不传，群状态保持不变。",
    },
  },
  required: ["panelId", "targets"],
} as const;

function okToolResult(): CustomChatToolResult {
  return {
    content: [{ type: "text", text: "ok" }],
  };
}

export function registerCustomChatGroupRouteTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "group_route",
    label: "Group Route",
    description:
      "Declare routing intent for the current reply in a CustomChat group: specify which roles should receive the next message, and optionally update the group task state (leaders only). Call this once per reply after composing your response. Pass an empty targets array if no further routing is needed.",
    parameters: GROUP_ROUTE_TOOL_SCHEMA,
    execute: async (toolCallId, rawParams) => {
      const runId = getRunIdByToolCallId(toolCallId);
      if (!runId) {
        throw new Error("group_route: cannot resolve runId for toolCallId=" + toolCallId);
      }

      const panelId =
        typeof rawParams.panelId === "string" ? rawParams.panelId.trim() : "";
      const targets = Array.isArray(rawParams.targets)
        ? (rawParams.targets as unknown[]).filter((t) => typeof t === "string").map((t) => (t as string).trim()).filter(Boolean)
        : [];
      const taskState =
        typeof rawParams.taskState === "string" ? rawParams.taskState.trim() : undefined;

      await sendPortalAppRpc("group_route.declare", {
        runId,
        panelId,
        targets,
        taskState,
      });

      return okToolResult();
    },
  });
}
