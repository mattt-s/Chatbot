import type { CustomChatToolApi, CustomChatToolResult } from "./api-types.js";
import { sendPortalAppRpc } from "./plugin-runtime.js";

const GROUP_TASK_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    panelId: {
      type: "string",
      description: "当前群组面板 ID。",
    },
    action: {
      type: "string",
      enum: [
        "create_task",
        "start_task",
        "submit_task",
        "approve_task",
        "reject_task",
        "approve_subtask",
        "reject_subtask",
        "block_on",
        "add_dependency",
        "list_tasks",
        "get_task",
        "cancel_task",
      ],
      description: "要执行的任务操作。",
    },
    // ── 任务标识 ──
    taskId: {
      type: "string",
      description: "目标任务 ID（大多数操作必填，create_task 除外）。",
    },
    // ── 调用方标识 ──
    callerRoleId: {
      type: "string",
      description: "调用方角色 ID（与 callerRoleTitle 二选一）。",
    },
    callerRoleTitle: {
      type: "string",
      description: "调用方角色名（与 callerRoleId 二选一）。",
    },
    // ── create_task 参数 ──
    title: {
      type: "string",
      description: "任务标题（create_task 必填）。",
    },
    description: {
      type: "string",
      description: "任务描述，包含上下文和验收标准（create_task 必填）。",
    },
    assigneeTitle: {
      type: "string",
      description: "执行者角色名（create_task 必填）。",
    },
    dependsOnTaskIds: {
      type: "array",
      items: { type: "string" },
      description: "前置任务 ID 列表（可选）。所有前置任务完成后才自动触发本任务。",
    },
    parentTaskId: {
      type: "string",
      description: "父任务 ID（成员提子任务时填写，可选）。",
    },
    autoApprove: {
      type: "boolean",
      description:
        "是否自动通过验收，仅 leader 可设为 true（默认 false）。设为 true 时 assignee 提交即视为通过，无需 leader 验收。",
    },
    // ── submit_task / reject_task 参数 ──
    note: {
      type: "string",
      description: "提交说明（submit_task）或驳回原因（reject_task / reject_subtask）。",
    },
    // ── block_on / add_dependency 参数 ──
    dependsOnTaskId: {
      type: "string",
      description: "要声明阻塞的前置任务 ID（block_on / add_dependency 必填）。",
    },
  },
  required: ["panelId", "action"],
} as const;

function okToolResult(data?: Record<string, unknown>): CustomChatToolResult {
  const text = data ? JSON.stringify(data, null, 2) : "ok";
  return {
    content: [{ type: "text", text }],
  };
}

export function registerCustomChatGroupTaskTool(api: CustomChatToolApi) {
  api.registerTool?.({
    name: "group_task",
    label: "Group Task",
    description: [
      "Manage tasks in a CustomChat task-mode group.",
      "Use this tool to create, start, submit, approve, reject, or query tasks.",
      "Always pass callerRoleId or callerRoleTitle so the app can identify the calling role.",
      "Available actions: create_task, start_task, submit_task, approve_task, reject_task,",
      "approve_subtask, reject_subtask, block_on, add_dependency, list_tasks, get_task.",
    ].join(" "),
    parameters: GROUP_TASK_TOOL_SCHEMA,
    execute: async (_toolCallId, rawParams) => {
      const panelId =
        typeof rawParams.panelId === "string" ? rawParams.panelId.trim() : "";
      const action =
        typeof rawParams.action === "string" ? rawParams.action.trim() : "";

      if (!panelId) throw new Error("group_task: panelId is required.");
      if (!action) throw new Error("group_task: action is required.");

      const result = await sendPortalAppRpc("group_task", {
        panelId,
        action,
        ...rawParams,
      });

      return okToolResult(result as Record<string, unknown>);
    },
  });
}
