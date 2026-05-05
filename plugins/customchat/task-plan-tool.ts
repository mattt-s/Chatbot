import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const TASK_PLAN_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["update_field"],
      description: "要执行的规划动作。目前仅支持 update_field（更新计划某个字段）。",
    },
    panelId: {
      type: "string",
      description: "当前群组面板 ID（必须是真实 panelId，UUID 格式）。",
    },
    field: {
      type: "string",
      enum: ["goal", "constraints", "deliverables", "acceptanceCriteria", "taskOutline"],
      description: [
        "要更新的字段：",
        "- goal：最终目标（string）",
        "- constraints：约束条件（string[]，完整替换）",
        "- deliverables：交付物（string[]，完整替换）",
        "- acceptanceCriteria：验收标准（string[]，完整替换）",
        "- taskOutline：高层任务草稿（string[]，完整替换）",
      ].join("\n"),
    },
    value: {
      description: "新值。goal 为 string，其余为 string[]。",
      oneOf: [
        { type: "string" },
        { type: "array", items: { type: "string" } },
      ],
    },
  },
  required: ["action", "panelId", "field", "value"],
} as const;

function jsonToolResult(payload: unknown): CustomChatToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerCustomChatTaskPlanTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "task_plan",
    label: "Task Plan",
    description: [
      "在任务模式规划阶段更新群组计划字段。",
      "每次用户回答一个问题后，立即调用此工具将答案写入对应字段。",
      "所有字段填写完毕并向用户确认后，告知用户点击「确认计划」按钮进入执行阶段。",
      "注意：规划阶段不得调用 group_task（create_task 会被系统拒绝）。",
    ].join(" "),
    parameters: TASK_PLAN_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const action =
        typeof rawParams.action === "string" ? rawParams.action.trim() : "";
      const panelId =
        typeof rawParams.panelId === "string" ? rawParams.panelId.trim() : "";

      if (!action) throw new Error("task_plan: action is required.");
      if (action !== "update_field") {
        return jsonToolResult({ ok: false, error: `Unknown action: ${action}` });
      }
      if (!panelId) throw new Error("task_plan: panelId is required.");

      const result = await sendPortalAppRpc("task_plan.update_field", {
        panelId,
        field: rawParams.field,
        value: rawParams.value,
      });

      return jsonToolResult(result);
    },
  });
}
