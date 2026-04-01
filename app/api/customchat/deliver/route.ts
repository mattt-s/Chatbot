/**
 * @file CustomChat 消息投递接口（插件→应用）
 * @description POST /api/customchat/deliver — 接收来自 customchat 插件的消息投递，通过 Bearer Token 认证
 */
import { NextResponse } from "next/server";

import { ensureCustomChatBridgeServer } from "@/lib/customchat-bridge-server";
import {
  customChatDeliverySchema,
  ingestCustomChatDelivery,
} from "@/lib/customchat-ingest";
import { getEnv } from "@/lib/env";

function readAuthToken(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }

  return request.headers.get("x-customchat-token")?.trim() || "";
}

/**
 * 接收 customchat 插件投递的消息
 * @description 使用 Bearer Token（CUSTOMCHAT_AUTH_TOKEN）认证。将投递数据校验后交给 ingest 流程处理。
 * @param request - HTTP 请求对象，Header 携带 Authorization Bearer Token，Body 为 CustomChatDelivery 结构
 * @returns 200 投递结果 | 400 参数无效或不支持的目标 | 401 Token 无效 | 404 面板不存在 | 500 服务端错误
 */
export async function POST(request: Request) {
  await ensureCustomChatBridgeServer().catch(() => null);
  const expectedAuthToken = getEnv().customChatAuthToken;
  if (!expectedAuthToken) {
    return NextResponse.json(
      { error: "CUSTOMCHAT_AUTH_TOKEN is not configured." },
      { status: 500 },
    );
  }

  const providedAuthToken = readAuthToken(request);
  if (!providedAuthToken || providedAuthToken !== expectedAuthToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = customChatDeliverySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload.", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await ingestCustomChatDelivery(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bridge delivery failed.";
    const status =
      message === "Unsupported customchat target."
        ? 400
        : message === "Panel not found."
          ? 404
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
