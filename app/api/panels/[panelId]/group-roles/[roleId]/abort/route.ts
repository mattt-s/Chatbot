/**
 * @file 群组角色运行中止接口
 * @description
 *   POST /api/panels/[panelId]/group-roles/[roleId]/abort — 中止指定角色当前运行
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { publishCustomChatEvent } from "@/lib/customchat-events";
import { abortGroupRoleRun } from "@/lib/group-router";
import {
  abortAssistantRun,
  blockPanelRun,
  findGroupRoleById,
  getPanelRecordForUser,
} from "@/lib/store";

type RouteContext = {
  params: Promise<{ panelId: string; roleId: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId, roleId } = await context.params;

  try {
    const panel = await getPanelRecordForUser(user.id, panelId);
    const role = await findGroupRoleById(roleId);
    if (!role || role.panelId !== panelId) {
      return NextResponse.json({ error: "Group role not found." }, { status: 404 });
    }

    const result = await abortGroupRoleRun(panelId, roleId);
    if (result.status === "idle" || !result.runId) {
      return NextResponse.json({
        ok: true,
        status: "idle",
      });
    }

    // Always block the run and publish aborted state regardless of verification.
    // The user clicked stop — no further deliveries should reach the UI even if
    // the LLM finishes generating in the background.
    await blockPanelRun(panelId, result.runId).catch(() => null);
    const aborted = await abortAssistantRun(panelId, result.runId, "group role aborted").catch(() => null);

    publishCustomChatEvent({
      runId: result.runId,
      sessionKey: panel.sessionKey,
      seq: Math.max(aborted?.eventSeq ?? 0, 1),
      state: "aborted",
      message: {
        text: aborted?.text ?? "",
      },
      stopReason: "group role aborted",
      groupRoleId: roleId,
      senderLabel: role.title,
    });

    if (result.status === "aborting") {
      return NextResponse.json(
        {
          ok: true,
          status: "aborting",
          runId: result.runId,
        },
        { status: 202 },
      );
    }

    return NextResponse.json({
      ok: true,
      status: "aborted",
      runId: result.runId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "终止角色推理失败。";
    const status = message === "Panel not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
