/**
 * @file 群组角色 Leader 设置接口
 * @description
 *   PUT    /api/panels/[panelId]/group-roles/[roleId]/leader — 设置该角色为组长
 *   DELETE /api/panels/[panelId]/group-roles/[roleId]/leader — 取消该角色的组长身份
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import {
  getPanelRecordForUser,
  setGroupRoleLeader,
  unsetGroupRoleLeader,
} from "@/lib/store";

type RouteContext = {
  params: Promise<{ panelId: string; roleId: string }>;
};

/**
 * 设置该角色为群组组长（同一群组内仅允许一个组长）
 */
export async function PUT(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, roleId } = await context.params;

  try {
    await getPanelRecordForUser(user.id, panelId);
    const role = await setGroupRoleLeader(panelId, roleId);
    return NextResponse.json({ ok: true, role });
  } catch (error) {
    const message = error instanceof Error ? error.message : "设置组长失败。";
    const status =
      message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * 取消该角色的组长身份
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, roleId } = await context.params;

  try {
    await getPanelRecordForUser(user.id, panelId);
    const role = await unsetGroupRoleLeader(panelId, roleId);
    return NextResponse.json({ ok: true, role });
  } catch (error) {
    const message = error instanceof Error ? error.message : "取消组长失败。";
    const status =
      message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
