/**
 * @file 面板 SSE 事件流接口
 * @description GET /api/panels/[panelId]/stream — 建立 SSE 长连接，实时推送该面板的聊天事件
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { ensureCustomChatBridgeServer } from "@/lib/customchat-bridge-server";
import { subscribeCustomChatEvent } from "@/lib/customchat-events";
import { subscribeGroupTasksUpdate } from "@/lib/task-mode/sse";
import {
  getPanelRecordForUser,
  setPanelActiveRun,
  upsertAssistantMessage,
  upsertAssistantRuntimeSteps,
} from "@/lib/store";
import type { ChatEventPayload } from "@/lib/types";
import { extractMessageText, normalizeCustomChatTarget } from "@/lib/utils";

type RouteContext = {
  params: Promise<{
    panelId: string;
  }>;
};

async function persistPanelChatEvent(panelId: string, payload: ChatEventPayload) {
  const text = extractMessageText(payload.message);

  await upsertAssistantMessage(panelId, {
    runId: payload.runId,
    text,
    state: payload.state,
    draft: payload.state === "delta",
    errorMessage: payload.errorMessage ?? undefined,
    stopReason: payload.stopReason ?? undefined,
    usage: payload.usage ?? undefined,
    seq: payload.seq,
    sessionMeta: payload.sessionMeta ?? undefined,
  }).catch(() => null);

  if (payload.runtimeSteps && payload.runtimeSteps.length > 0) {
    await upsertAssistantRuntimeSteps(
      panelId,
      payload.runId,
      payload.runtimeSteps,
    ).catch(() => null);
  }

  if (payload.state === "delta") {
    await setPanelActiveRun(panelId, payload.runId).catch(() => null);
    return;
  }

  if (
    payload.state === "final" ||
    payload.state === "aborted" ||
    payload.state === "error"
  ) {
    await setPanelActiveRun(panelId, null).catch(() => null);
  }
}

function matchesPanelSession(
  eventSessionKey: string | null | undefined,
  panelSessionKey: string,
  panelId: string,
  panelKind?: string,
) {
  if (!eventSessionKey?.trim()) {
    return false;
  }

  if (eventSessionKey === panelSessionKey) {
    return true;
  }

  const eventNorm = normalizeCustomChatTarget(eventSessionKey);
  const panelNorm = normalizeCustomChatTarget(panelSessionKey);
  if (eventNorm && panelNorm && eventNorm === panelNorm) {
    return true;
  }

  // 群组：事件来自该 panel 下的任意角色 session
  if (panelKind === "group" && eventNorm === `panel:${panelId}`) {
    return true;
  }

  return false;
}

/**
 * 建立面板的 SSE 事件流连接
 * @description 需要用户登录。订阅与面板 sessionKey 匹配的聊天事件，实时推送 delta/final/aborted/error 等状态。
 *   连接建立后先发送 hello 事件，之后持续推送 chat 事件，每 15 秒发送心跳。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 panelId 路径参数
 * @returns SSE 流（text/event-stream） | 401 未登录 | 404 面板不存在
 */
export async function GET(_request: Request, context: RouteContext) {
  await ensureCustomChatBridgeServer().catch(() => null);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { panelId } = await context.params;
  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  let unsubscribeChat: (() => void) | null = null;
  let unsubscribeTasks: (() => void) | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: string, payload: unknown) => {
        if (closed) {
          return;
        }
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
        );
      };

      push("hello", {
        transport: "provider-channel",
        sessionKey: panel.sessionKey,
      });

      unsubscribeChat = subscribeCustomChatEvent((chatPayload) => {
        if (!matchesPanelSession(chatPayload.sessionKey, panel.sessionKey, panel.id, panel.kind)) {
          return;
        }

        void persistPanelChatEvent(panel.id, chatPayload);
        push("chat", {
          ...chatPayload,
          sessionKey: panel.sessionKey,
        });
      });

      // 任务看板变更通知（合并进主 stream，避免额外的 SSE 连接）
      unsubscribeTasks = subscribeGroupTasksUpdate((updatedPanelId) => {
        if (updatedPanelId !== panel.id) return;
        push("tasks_updated", { panelId: panel.id });
      });

      heartbeatTimer = globalThis.setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15_000);
    },
    async cancel() {
      closed = true;
      if (heartbeatTimer) {
        globalThis.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (unsubscribeChat) {
        unsubscribeChat();
        unsubscribeChat = null;
      }
      if (unsubscribeTasks) {
        unsubscribeTasks();
        unsubscribeTasks = null;
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
