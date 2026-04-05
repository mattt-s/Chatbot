import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const MANAGE_GROUP_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "list_agents",
        "list_groups",
        "create_group",
        "delete_group",
        "get_group_task_state",
        "send_group_message",
        "add_group_role",
        "update_group_role",
        "set_group_leader",
        "unset_group_leader",
        "remove_group_role",
      ],
      description: "要执行的群组管理动作。",
    },
    panelId: {
      type: "string",
      description: "群组面板 ID。若不确定，可先 list_groups。",
    },
    panelTitle: {
      type: "string",
      description: "群组名称。仅在 group title 唯一时用于定位群组。",
    },
    title: {
      type: "string",
      description: "创建群组时的群名称，或新增/更新角色时的角色名。",
    },
    message: {
      type: "string",
      description: "发送到群里的消息正文。群内角色会把它视为用户发来的消息。",
    },
    agentId: {
      type: "string",
      description: "角色绑定的 agentId。若不确定，可先 list_agents。",
    },
    emoji: {
      type: "string",
      description: "角色 emoji，可选。",
    },
    isLeader: {
      type: "boolean",
      description: "add_group_role 时是否直接设为组长。",
    },
    enabled: {
      type: "boolean",
      description: "update_group_role 时用于启用/禁用角色。",
    },
    roleId: {
      type: "string",
      description: "角色 ID。若不确定，可先 list_groups。",
    },
    roleTitle: {
      type: "string",
      description: "角色名。仅在同群组内角色名唯一时可用于定位角色。",
    },
    roles: {
      type: "array",
      description: "create_group 时一次性创建的角色列表。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          agentId: { type: "string" },
          emoji: { type: "string" },
          isLeader: { type: "boolean" },
        },
        required: ["title", "agentId"],
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
    case "list_agents":
      return { method: "agents.list", params: {} };
    case "list_groups":
      return { method: "group.list", params: {} };
    case "create_group":
      return {
        method: "group.create",
        params: {
          title: readString(params, "title"),
          roles: Array.isArray(params.roles) ? params.roles : [],
        },
      };
    case "delete_group":
      return {
        method: "group.delete",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
        },
      };
    case "get_group_task_state":
      return {
        method: "group.get",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
        },
      };
    case "send_group_message":
      return {
        method: "group.message",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          message: readString(params, "message"),
        },
      };
    case "add_group_role":
      return {
        method: "group_role.add",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          title: readString(params, "title"),
          agentId: readString(params, "agentId"),
          emoji: readString(params, "emoji"),
          isLeader: params.isLeader === true,
        },
      };
    case "update_group_role":
      return {
        method: "group_role.update",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          roleId: readString(params, "roleId"),
          roleTitle: readString(params, "roleTitle"),
          title: readString(params, "title"),
          agentId: readString(params, "agentId"),
          emoji: params.emoji,
          enabled: params.enabled,
        },
      };
    case "set_group_leader":
      return {
        method: "group_role.set_leader",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          roleId: readString(params, "roleId"),
          roleTitle: readString(params, "roleTitle"),
          enabled: true,
        },
      };
    case "unset_group_leader":
      return {
        method: "group_role.set_leader",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          roleId: readString(params, "roleId"),
          roleTitle: readString(params, "roleTitle"),
          enabled: false,
        },
      };
    case "remove_group_role":
      return {
        method: "group_role.remove",
        params: {
          panelId: readString(params, "panelId"),
          panelTitle: readString(params, "panelTitle"),
          roleId: readString(params, "roleId"),
          roleTitle: readString(params, "roleTitle"),
        },
      };
    default:
      throw new Error(`Unknown manage_group action: ${action || "<empty>"}`);
  }
}

export function registerCustomChatGroupManagementTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "manage_group",
    label: "Manage Group",
    description:
      "Create and manage CustomChat groups and group roles in the ChatBot app. " +
      "Use this for creating or deleting groups, checking group task state, " +
      "sending a user message into a group, adding/removing roles, setting leader, or listing groups/agents.",
    parameters: MANAGE_GROUP_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const { method, params } = normalizeAppRpcPayload(rawParams);
      const result = await sendPortalAppRpc(method, params);
      return jsonToolResult(result);
    },
  });
}
