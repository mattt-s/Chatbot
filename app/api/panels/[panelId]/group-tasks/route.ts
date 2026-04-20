/**
 * @file 任务模式任务列表接口
 * @description GET /api/panels/[panelId]/group-tasks — 获取群组面板的任务列表
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser, readGroupTasks } from "@/lib/store";
import { taskToView } from "@/lib/task-mode/types";

type RouteContext = {
  params: Promise<{ panelId: string }>;
};

/**
 * 获取任务列表
 * @description 需要用户登录。返回面板下所有任务的视图对象。
 * @returns 200 { tasks: GroupTaskView[] } | 401 | 404
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  const tasks = await readGroupTasks(panelId);
  return NextResponse.json({ tasks: tasks.map(taskToView) });
}
