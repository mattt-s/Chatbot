/**
 * @file Dashboard 面板列表 SSE 事件流接口
 * @description GET /api/panels/stream — 建立 SSE 长连接，推送当前用户的面板列表变更事件
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { subscribeDashboardPanelEvent } from "@/lib/panel-events";

/**
 * 建立 dashboard 级面板列表变更 SSE 流。
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: string, payload: unknown) => {
        if (closed) {
          return;
        }
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      };

      push("hello", {
        transport: "dashboard-panels",
        userId: user.id,
      });

      unsubscribe = subscribeDashboardPanelEvent(user.id, (payload) => {
        push("panel", {
          panelId: payload.panelId,
          reason: payload.reason,
          ts: payload.ts,
        });
      });

      heartbeatTimer = globalThis.setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
    },
    cancel() {
      closed = true;
      if (heartbeatTimer) {
        globalThis.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      return undefined;
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
