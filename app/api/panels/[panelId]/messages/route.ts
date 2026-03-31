/**
 * @file 面板消息集合操作接口
 * @description DELETE /api/panels/[panelId]/messages — 清空指定面板的所有消息
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { clearPanelMessages, getPanelRecordForUser } from "@/lib/store";

type RouteContext = {
  params: Promise<{
    panelId: string;
  }>;
};

/**
 * 清空指定面板的所有消息
 * @description 需要用户登录。如果面板当前有活跃运行（activeRunId），则拒绝清空。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns 200 清空结果 | 401 未登录 | 404 面板不存在 | 409 面板有活跃任务 | 500 清空失败
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;

  try {
    const panel = await getPanelRecordForUser(user.id, panelId);
    if (panel.activeRunId) {
      return NextResponse.json(
        { error: "当前任务仍在进行中，无法清空消息。" },
        { status: 409 },
      );
    }

    const cleared = await clearPanelMessages(user.id, panelId);
    return NextResponse.json(cleared);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "清空消息失败。";
    const status = message === "Panel not found." ? 404 : 500;

    return NextResponse.json({ error: message }, { status });
  }
}
