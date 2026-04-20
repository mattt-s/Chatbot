/**
 * @file 任务操作接口（用户介入）
 * @description POST /api/panels/[panelId]/group-tasks/[taskId]
 *   用户通过 UI 对任务执行介入操作：取消、重新 dispatch、标记忽略等。
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser } from "@/lib/store";
import {
  getGroupTask,
  updateGroupTaskStatus,
  appendTaskEvent,
} from "@/lib/task-mode/store";
import {
  dispatchTaskMessage,
  buildAssignmentMessage,
} from "@/lib/task-mode/dispatch";
import { taskToView } from "@/lib/task-mode/types";
import { listGroupRoles } from "@/lib/store";

type RouteContext = {
  params: Promise<{ panelId: string; taskId: string }>;
};

/**
 * 用户对任务执行介入操作
 * @body { action: "cancel" | "redispatch" | "reset_watchdog", note?: string }
 */
export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, taskId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action.trim() : "";
  const note = typeof body.note === "string" ? body.note.trim() : "";

  if (!action) {
    return NextResponse.json({ error: "action is required." }, { status: 400 });
  }

  const task = await getGroupTask(panelId, taskId);
  if (!task) {
    return NextResponse.json({ error: "Task not found." }, { status: 404 });
  }

  switch (action) {
    case "cancel": {
      const { TASK_TERMINAL_STATUSES } = await import("@/lib/task-mode/types");
      if (TASK_TERMINAL_STATUSES.has(task.status)) {
        return NextResponse.json(
          { error: `任务已是终态 "${task.status}"，无法取消。` },
          { status: 400 },
        );
      }
      const updated = await updateGroupTaskStatus(panelId, taskId, "cancelled", {
        type: "cancelled",
        actorRoleId: user.id,
        actorRoleTitle: "用户介入",
        note: note || "用户从看板手动取消",
      });
      return NextResponse.json({ ok: true, task: taskToView(updated) });
    }

    case "redispatch": {
      if (task.status !== "needs_intervention" && task.status !== "assigned") {
        return NextResponse.json(
          { error: `任务状态 "${task.status}" 不支持重新 dispatch。` },
          { status: 400 },
        );
      }
      if (!task.assigneeRoleId) {
        return NextResponse.json(
          { error: "任务没有 assignee，无法 redispatch。" },
          { status: 400 },
        );
      }

      const roles = await listGroupRoles(panelId);
      const assigneeRole = roles.find((r) => r.id === task.assigneeRoleId);
      if (!assigneeRole) {
        return NextResponse.json(
          { error: "Assignee 角色不存在。" },
          { status: 400 },
        );
      }

      // 重置 watchdog 计数，恢复为 assigned 状态
      const { updateGroupTaskField } = await import("@/lib/task-mode/store");
      await updateGroupTaskField(panelId, taskId, "watchdogRetryCount", 0);

      const updated = await updateGroupTaskStatus(panelId, taskId, "assigned", {
        type: "assigned",
        actorRoleId: user.id,
        actorRoleTitle: "用户介入",
        note: note || "用户从看板重新分配",
      });

      await dispatchTaskMessage({
        panelId,
        roleId: assigneeRole.id,
        agentId: assigneeRole.agentId,
        text: buildAssignmentMessage(updated),
        taskId,
        isLeader: assigneeRole.isLeader === true,
        roleTitle: assigneeRole.title,
      });

      return NextResponse.json({ ok: true, task: taskToView(updated) });
    }

    case "reset_watchdog": {
      await appendTaskEvent(panelId, taskId, {
        type: "comment",
        actorRoleId: user.id,
        actorRoleTitle: "用户介入",
        note: note || "用户重置 watchdog 计数",
      });
      const { updateGroupTaskField } = await import("@/lib/task-mode/store");
      await updateGroupTaskField(panelId, taskId, "watchdogRetryCount", 0);
      const refreshed = await getGroupTask(panelId, taskId);
      return NextResponse.json({
        ok: true,
        task: refreshed ? taskToView(refreshed) : null,
      });
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
  }
}
