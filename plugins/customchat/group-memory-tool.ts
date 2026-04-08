import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const MANAGE_GROUP_MEMORY_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["get_memory", "update_my_memory", "clear_my_memory"],
      description:
        "要执行的记忆板动作：get_memory=读取所有成员记忆，update_my_memory=更新自己的记忆，clear_my_memory=清空自己的记忆。",
    },
    panelId: {
      type: "string",
      description: "群组面板 ID。",
    },
    roleId: {
      type: "string",
      description: "执行操作的角色 ID（update/clear 时必填）。",
    },
    roleTitle: {
      type: "string",
      description: "执行操作的角色显示名（update 时必填，便于其他成员识别）。",
    },
    content: {
      type: "string",
      description:
        "精简的记忆内容，只记录核心信息：负责的文件路径、当前任务进度、当前遇到的问题等。内容务必简洁。",
    },
  },
  required: ["action", "panelId"],
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
    case "get_memory":
      return {
        method: "group_memory.get",
        params: {
          panelId: readString(params, "panelId"),
        },
      };
    case "update_my_memory":
      return {
        method: "group_memory.update",
        params: {
          panelId: readString(params, "panelId"),
          roleId: readString(params, "roleId"),
          roleTitle: readString(params, "roleTitle"),
          content: readString(params, "content"),
        },
      };
    case "clear_my_memory":
      return {
        method: "group_memory.clear",
        params: {
          panelId: readString(params, "panelId"),
          roleId: readString(params, "roleId"),
        },
      };
    default:
      throw new Error(`Unknown manage_group_memory action: ${action || "<empty>"}`);
  }
}

export function registerCustomChatGroupMemoryTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "manage_group_memory",
    label: "Manage Group Memory",
    description:
      "Read all group members' memory, or update/clear your own memory entry on the shared memory board of a CustomChat group.",
    parameters: MANAGE_GROUP_MEMORY_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const { method, params } = normalizeAppRpcPayload(rawParams);
      const result = await sendPortalAppRpc(method, params);
      return jsonToolResult(result);
    },
  });
}
