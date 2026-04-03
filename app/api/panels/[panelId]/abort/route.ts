/**
 * @file 中止面板运行接口
 * @description POST /api/panels/[panelId]/abort — 中止指定面板当前正在进行的代理运行
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { publishCustomChatEvent } from "@/lib/customchat-events";
import { abortProviderRun } from "@/lib/customchat-provider";
import {
  abortAssistantRun,
  blockPanelRun,
  getPanelRecordForUser,
  setPanelActiveRun,
} from "@/lib/store";

type RouteContext = {
  params: Promise<{
    panelId: string;
  }>;
};

/**
 * 中止面板当前活跃的代理运行
 * @description 需要用户登录。先尝试远程 Provider 中止，再本地标记中止状态并发布 SSE 事件。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns 200 { ok, status: "aborted"|"idle" } | 202 正在中止 | 401 未登录 | 404 面板不存在 | 502 远程中止失败
 */
export async function POST(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  const runId = panel.activeRunId?.trim() || null;
  if (!runId) {
    return NextResponse.json({
      ok: true,
      status: "idle",
    });
  }

  let providerAbort: Awaited<ReturnType<typeof abortProviderRun>> | null = null;
  try {
    providerAbort = await abortProviderRun({
      panelId,
      agentId: panel.agentId,
      runId,
      sessionKey: panel.sessionKey,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Remote abort failed.",
      },
      { status: 502 },
    );
  }

  // Always block the run and publish aborted state regardless of whether the
  // Gateway confirmed the abort. The user clicked stop — no further deliveries
  // should reach the UI even if the LLM finishes generating in the background.
  await blockPanelRun(panelId, runId).catch(() => null);
  const aborted = await abortAssistantRun(panelId, runId).catch(() => null);
  await setPanelActiveRun(panelId, null).catch(() => null);

  publishCustomChatEvent({
    runId,
    sessionKey: panel.sessionKey,
    seq: Math.max((aborted?.eventSeq ?? 0), 1),
    state: "aborted",
    message: {
      text: aborted?.text ?? "",
    },
    stopReason: "user aborted",
  });

  if (providerAbort?.verified === false) {
    return NextResponse.json(
      {
        ok: true,
        status: "aborting",
        runId,
        session: providerAbort.session ?? null,
      },
      { status: 202 },
    );
  }

  return NextResponse.json({
    ok: true,
    status: "aborted",
    runId,
  });
}
