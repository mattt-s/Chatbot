/**
 * @file 单个群组角色操作接口
 * @description
 *   PATCH  /api/panels/[panelId]/group-roles/[roleId] — 更新角色信息
 *   DELETE /api/panels/[panelId]/group-roles/[roleId] — 删除角色
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { deleteProviderSession } from "@/lib/customchat-provider";
import { resetInitializedRoles } from "@/lib/group-router";
import { toCustomChatGroupRoleTarget } from "@/lib/utils";
import {
  findGroupRoleById,
  getPanelRecordForUser,
  removeGroupRole,
  updateGroupRole,
} from "@/lib/store";

type RouteContext = {
  params: Promise<{ panelId: string; roleId: string }>;
};

/**
 * 更新群组角色信息
 * Body: { title?: string, emoji?: string, agentId?: string, enabled?: boolean }
 */
export async function PATCH(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, roleId } = await context.params;

  try {
    await getPanelRecordForUser(user.id, panelId);

    const body = (await request.json()) as {
      title?: string;
      emoji?: string | null;
      agentId?: string;
      enabled?: boolean;
    };

    const role = await updateGroupRole(roleId, body);

    // 角色变更后重置初始化标记
    resetInitializedRoles(panelId);

    return NextResponse.json({ ok: true, role });
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新角色失败。";
    const status =
      message === "Panel not found." || message === "Group role not found."
        ? 404
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * 删除群组角色
 * @description 先查找角色信息，再删除本地记录，最后尝试清理 Gateway 侧 session。
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, roleId } = await context.params;

  try {
    await getPanelRecordForUser(user.id, panelId);

    // 删除前先获取角色信息，用于清理 Gateway session
    const role = await findGroupRoleById(roleId);

    await removeGroupRole(roleId);

    // 角色变更后重置初始化标记
    resetInitializedRoles(panelId);

    // 尝试清理 Gateway 侧该角色的 session（fire-and-forget）
    if (role) {
      deleteProviderSession({
        panelId,
        agentId: role.agentId,
        target: toCustomChatGroupRoleTarget(panelId, roleId),
      }).catch(() => {
        // 忽略远端清理失败
      });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除角色失败。";
    const status =
      message === "Panel not found." || message === "Group role not found."
        ? 404
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
