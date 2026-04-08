/**
 * @file 单个面板 CRUD 接口
 * @description
 *   GET    /api/panels/[panelId] — 获取面板详情
 *   PATCH  /api/panels/[panelId] — 更新面板属性（标题、代理、角色名等）
 *   DELETE /api/panels/[panelId] — 删除面板（同时清理远程会话）
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { deleteProviderSession } from "@/lib/customchat-provider";
import { normalizeGroupTaskState } from "@/lib/group-task";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import {
  deletePanel,
  getPanelRecordForUser,
  getPanelViewForUser,
  listGroupRoles,
  updatePanel,
} from "@/lib/store";

const patchSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  agentId: z.string().min(1).optional(),
  userRoleName: z.string().max(40).optional(),
  assistantRoleName: z.string().max(40).optional(),
  taskStateSelection: z.enum(["idle", "in_progress", "waiting_input", "blocked", "pending_review", "completed"]).optional(),
});

type RouteContext = {
  params: Promise<{
    panelId: string;
  }>;
};

/**
 * 获取面板详情
 * @description 需要用户登录且面板属于当前用户。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns 200 PanelView | 401 未登录 | 404 面板不存在
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;

  try {
    return NextResponse.json(await getPanelViewForUser(user.id, panelId));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "读取面板失败。",
      },
      { status: 404 },
    );
  }
}

/**
 * 更新面板属性
 * @description 需要用户登录。可更新 title、agentId、userRoleName、assistantRoleName。
 * @param request - HTTP 请求对象，Body 为 { title?: string, agentId?: string, userRoleName?: string, assistantRoleName?: string }
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns 200 更新后的面板 | 400 参数错误 | 401 未登录 | 404 面板不存在
 */
export async function PATCH(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const json = await request.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误。" }, { status: 400 });
  }

  try {
    if (typeof parsed.data.taskStateSelection === "string") {
      const panel = await getPanelRecordForUser(user.id, panelId);
      if ((panel.kind ?? "direct") !== "group") {
        return NextResponse.json({ error: "仅群组支持修改任务状态。" }, { status: 400 });
      }
    }

    return NextResponse.json(
      await updatePanel(user.id, panelId, {
        ...parsed.data,
        taskStateSelection:
          typeof parsed.data.taskStateSelection === "string"
            ? normalizeGroupTaskState(parsed.data.taskStateSelection)
            : undefined,
      }),
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "更新面板失败。",
      },
      { status: 404 },
    );
  }
}

/**
 * 删除面板
 * @description 需要用户登录。先尝试删除 Provider 端远程会话，再删除本地面板数据。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns 200 { ok, remoteSessionDeleted, remoteWarning } | 401 未登录 | 404 面板不存在 | 502 删除失败
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;

  try {
    const panel = await getPanelRecordForUser(user.id, panelId);
    let remoteSessionDeleted = false;
    let remoteWarning: string | null = null;

    const isGroup = (panel.kind ?? "direct") === "group";

    if (isGroup) {
      // 群组面板：逐个清理每个角色的 Gateway session
      const roles = await listGroupRoles(panelId);
      const results = await Promise.allSettled(
        roles.map((role) =>
          deleteProviderSession({
            panelId,
            agentId: role.agentId,
            target: toCustomChatGroupRoleTarget(panelId, role.id),
          }),
        ),
      );
      const allOk = results.every((r) => r.status === "fulfilled");
      remoteSessionDeleted = allOk && results.length > 0;
      if (!allOk) {
        const failures = results.filter((r) => r.status === "rejected").length;
        remoteWarning = `${failures}/${results.length} role session(s) failed to delete.`;
      }
    } else {
      // 普通面板：原有逻辑
      try {
        await deleteProviderSession({
          panelId,
          agentId: panel.agentId,
        });
        remoteSessionDeleted = true;
      } catch (error) {
        remoteWarning =
          error instanceof Error ? error.message : "Remote session delete failed.";
      }
    }

    const result = await deletePanel(user.id, panelId);
    return NextResponse.json({
      ...result,
      remoteSessionDeleted,
      remoteWarning,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "删除面板失败。";
    const status = message === "Panel not found." ? 404 : 502;

    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }
}
