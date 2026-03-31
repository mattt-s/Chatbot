/**
 * @file 群组角色集合操作接口
 * @description
 *   GET  /api/panels/[panelId]/group-roles — 列出群组面板下的所有角色
 *   POST /api/panels/[panelId]/group-roles — 创建新的群组角色
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import {
  getGroupRoleRuntimeStatuses,
  resetInitializedRoles,
  verifyGroupRoleRuntimeStatuses,
} from "@/lib/group-router";
import {
  createGroupRole,
  getPanelRecordForUser,
  listGroupRoles,
} from "@/lib/store";

type RouteContext = {
  params: Promise<{ panelId: string }>;
};

/**
 * 列出群组面板下的所有角色
 */
export async function GET(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const shouldVerify = new URL(request.url).searchParams.get("verify") === "1";

  try {
    await getPanelRecordForUser(user.id, panelId);
    const roles = await listGroupRoles(panelId);
    const runtimeStatuses = shouldVerify
      ? await verifyGroupRoleRuntimeStatuses(panelId, roles)
      : getGroupRoleRuntimeStatuses(panelId);
    return NextResponse.json({
      ok: true,
      roles: roles.map((role) => {
        const runtime = runtimeStatuses.get(role.id);
        return runtime
          ? { ...role, ...runtime }
          : {
              ...role,
              runtimeStatus: "idle" as const,
              activeRunId: null,
              busyAgeMs: null,
              runtimeSource: "verified" as const,
              runtimeNote: shouldVerify ? "已核验为空闲" : null,
            };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取角色列表失败。";
    const status = message === "Panel not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * 创建新的群组角色
 * Body: { agentId: string, title: string, emoji?: string, isLeader?: boolean }
 */
export async function POST(request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;

  try {
    const panel = await getPanelRecordForUser(user.id, panelId);
    if (panel.kind !== "group") {
      return NextResponse.json(
        { error: "只有群组面板可以添加角色。" },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      agentId?: string;
      title?: string;
      emoji?: string;
      isLeader?: boolean;
    };

    if (!body.agentId?.trim()) {
      return NextResponse.json({ error: "agentId is required." }, { status: 400 });
    }
    if (!body.title?.trim()) {
      return NextResponse.json({ error: "title is required." }, { status: 400 });
    }

    const role = await createGroupRole({
      panelId,
      agentId: body.agentId.trim(),
      title: body.title.trim(),
      emoji: body.emoji ?? null,
      isLeader: body.isLeader ?? false,
    });

    // 角色变更后重置初始化标记，下次 dispatch 时重新注入成员列表
    resetInitializedRoles(panelId);

    return NextResponse.json({ ok: true, role });
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建角色失败。";
    const status = message === "Panel not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
