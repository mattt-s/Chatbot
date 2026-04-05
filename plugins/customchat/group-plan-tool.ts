import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const MANAGE_GROUP_PLAN_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["get_plan", "update_plan", "clear_plan"],
      description: "要执行的群计划动作。",
    },
    panelId: {
      type: "string",
      description: "群组面板 ID。若不确定，可先通过 manage_group 查看群组列表。",
    },
    panelTitle: {
      type: "string",
      description: "群组名称。仅在 group title 唯一时用于定位群组。",
    },
    summary: {
      type: "string",
      description: "面向用户展示的简洁进度摘要。",
    },
    updatedByLabel: {
      type: "string",
      description: "更新 plan 的角色名或显示名，可选。",
    },
    items: {
      type: "array",
      description: "群计划条目列表。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "done", "blocked"],
          },
        },
        required: ["title", "status"],
      },
    },
  },
  required: ["action"],
} as const;

function jsonToolResult(payload: unknown): CustomChatToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

function readString(params: Record<string, unknown>, key: string) {
  return typeof params[key] === "string" ? params[key].trim() : "";
}

function normalizeAppRpcPayload(params: Record<string, unknown>) {
  const action = readString(params, "action");
  switch (action) {
    case "get_plan":
      return {
        method: "group_plan.get",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
        },
      };
    case "update_plan":
      return {
        method: "group_plan.update",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          summary: readString(params, "summary"),
          updatedByLabel: readString(params, "updatedByLabel"),
          items: Array.isArray(params.items) ? params.items : [],
        },
      };
    case "clear_plan":
      return {
        method: "group_plan.clear",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
        },
      };
    default:
      throw new Error(`Unknown manage_group_plan action: ${action || "<empty>"}`);
  }
}

export function registerCustomChatGroupPlanTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "manage_group_plan",
    label: "Manage Group Plan",
    description:
      "Read, update, or clear the user-facing progress plan of a CustomChat group in the ChatBot app.",
    parameters: MANAGE_GROUP_PLAN_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const { method, params } = normalizeAppRpcPayload(rawParams);
      const result = await sendPortalAppRpc(method, params);
      return jsonToolResult(result);
    },
  });
}
