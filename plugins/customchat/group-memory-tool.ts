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
      description:
        "执行操作的角色 ID。只有在你明确知道真实角色 ID 时才填写；它通常是类似 360f80e3-c405-4f9d-a362-40f1d245f6bb 的长 UUID。不要把 ui、rd、techlead 这类角色名填到 roleId 里。若不确定 roleId，请留空并改传 roleTitle。",
    },
    roleTitle: {
      type: "string",
      description:
        "执行操作的角色显示名，例如 ui、rd、techlead。拿不准 roleId 时，优先只传 roleTitle；不要把 roleTitle 复制到 roleId。",
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
      "Read all group members' memory, or update/clear your own memory entry on the shared memory board of a CustomChat group. Prefer roleTitle when identifying a role; only pass roleId when you know the real UUID-like role ID, and never copy a role name such as ui into roleId.",
    parameters: MANAGE_GROUP_MEMORY_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const { method, params } = normalizeAppRpcPayload(rawParams);
      const result = await sendPortalAppRpc(method, params);
      return jsonToolResult(result);
    },
  });
}
