/**
 * @file GET /api/panels/[panelId]/task-plan
 * 返回当前面板的 TaskModePlan（无则返回空 Plan）。
 */
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser } from "@/lib/store";
import { getOrCreateTaskModePlan } from "@/lib/task-mode/plan-store";

type RouteContext = { params: Promise<{ panelId: string }> };

export async function GET(_req: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) return NextResponse.json({ error: "Panel not found." }, { status: 404 });

  const plan = await getOrCreateTaskModePlan(panelId);
  return NextResponse.json({ plan });
}
