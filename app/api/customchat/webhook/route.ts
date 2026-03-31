/**
 * @file CustomChat Webhook 发送消息接口
 * @description POST /api/customchat/webhook — 用户通过此接口向指定面板发送消息（支持文件上传）
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { ensureCustomChatBridgeServer } from "@/lib/customchat-bridge-server";
import { submitGroupMessage } from "@/lib/group-message";
import { submitPanelMessage } from "@/lib/panel-message";
import { getPanelRecordForUser } from "@/lib/store";

/**
 * 向指定面板发送用户消息
 * @description 需要用户登录。请求体为 FormData，包含 panelId、message、messageId 和可选的 files 附件。
 * @param request - HTTP 请求对象，Body 为 FormData { panelId: string, message: string, messageId?: string, files?: File[] }
 * @returns 200 { ok, runId, status, userMessage } | 400 缺少参数或消息为空 | 401 未登录 | 404 面板不存在 | 502 发送失败
 */
export async function POST(request: Request) {
  await ensureCustomChatBridgeServer().catch(() => null);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const panelId = String(formData.get("panelId") ?? "").trim();
  if (!panelId) {
    return NextResponse.json({ error: "panelId is required." }, { status: 400 });
  }

  const panel = await getPanelRecordForUser(user.id, panelId).catch(() => null);
  if (!panel) {
    return NextResponse.json({ error: "Panel not found." }, { status: 404 });
  }

  const message = String(formData.get("message") ?? "");
  const messageId = String(formData.get("messageId") ?? "").trim() || undefined;
  const files = formData
    .getAll("files")
    .filter((value) => value instanceof File) as File[];

  try {
    // 群组面板走群组路由，直接面板走 Provider 投递
    if (panel.kind === "group") {
      const result = await submitGroupMessage({
        user,
        panel,
        message,
        files,
        messageId,
      });

      return NextResponse.json({
        ok: true,
        runId: null,
        status: "routed",
        userMessage: result.userMessage,
      });
    }

    const result = await submitPanelMessage({
      user,
      panel,
      message,
      files,
      messageId,
    });

    return NextResponse.json({
      ok: true,
      runId: result.runId,
      status: result.status,
      userMessage: result.userMessage,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "发送失败。";
    const status = message === "消息不能为空。" ? 400 : 502;
    return NextResponse.json(
      {
        error: message,
      },
      { status },
    );
  }
}
