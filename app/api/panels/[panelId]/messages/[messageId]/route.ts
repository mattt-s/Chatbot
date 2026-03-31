/**
 * @file 单条消息操作接口
 * @description DELETE /api/panels/[panelId]/messages/[messageId] — 删除指定面板中的一条消息
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { deletePanelMessage, getPanelRecordForUser } from "@/lib/store";

type RouteContext = {
  params: Promise<{
    panelId: string;
    messageId: string;
  }>;
};

/**
 * 删除指定面板中的一条消息
 * @description 需要用户登录且面板属于当前用户。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 和 messageId 路径参数
 * @returns 200 删除结果 | 400 删除失败 | 401 未登录 | 404 面板不存在
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, messageId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  try {
    const result = await deletePanelMessage(user.id, panelId, messageId);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "删除消息失败。",
      },
      { status: 400 },
    );
  }
}
