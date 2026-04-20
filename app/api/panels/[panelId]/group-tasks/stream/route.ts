/**
 * @file 任务模式看板 SSE 端点
 * @description GET /api/panels/[panelId]/group-tasks/stream
 *   建立 SSE 长连接，任务状态发生任何变更时推送 "tasks_updated" 事件。
 *   前端收到后调用 GET /group-tasks 重新拉取完整任务列表。
 */
import { getCurrentUser } from "@/lib/auth";
import { getPanelRecordForUser } from "@/lib/store";
import { subscribeGroupTasksUpdate } from "@/lib/task-mode/sse";

type RouteContext = {
  params: Promise<{ panelId: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return new Response(JSON.stringify({ error: "Panel not found." }), { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // 建立连接即发 hello
      push("hello", { panelId });

      // 订阅任务变更通知
      unsubscribe = subscribeGroupTasksUpdate((updatedPanelId) => {
        if (updatedPanelId !== panelId) return;
        push("tasks_updated", { panelId });
      });

      // 每 15 秒心跳，保持连接
      heartbeatTimer = globalThis.setInterval(() => {
        if (!closed) {
          controller.enqueue(encoder.encode(": ping\n\n"));
        }
      }, 15_000);
    },
    cancel() {
      closed = true;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (heartbeatTimer) { globalThis.clearInterval(heartbeatTimer); heartbeatTimer = null; }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}
