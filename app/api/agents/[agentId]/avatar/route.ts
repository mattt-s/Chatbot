/**
 * @file 代理头像代理接口
 * @description GET /api/agents/[agentId]/avatar — 通过 WS RPC 从 Plugin 获取指定代理的头像图片
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { ensureCustomChatBridgeServer, isPluginConnected, sendRpcToPlugin } from "@/lib/customchat-bridge-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = {
  params: Promise<{
    agentId: string;
  }>;
};

/**
 * 获取指定代理的头像图片
 * @description 需要用户登录。通过 WS RPC 从 Plugin 获取头像 base64 数据并返回。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 agentId 路径参数
 * @returns 200 头像二进制数据 | 401 未登录 | 404 头像未找到 | 503 Plugin 不可用
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await context.params;

  await ensureCustomChatBridgeServer().catch(() => null);
  if (!isPluginConnected()) {
    return NextResponse.json({ error: "Plugin unavailable." }, { status: 503 });
  }

  try {
    const result = await sendRpcToPlugin<{
      ok?: boolean;
      mimeType?: string;
      base64?: string;
    }>("agent.avatar", { agentId });

    if (!result?.base64) {
      return NextResponse.json({ error: "Avatar not found." }, { status: 404 });
    }

    const buffer = Buffer.from(result.base64, "base64");
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": result.mimeType || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Avatar not found." }, { status: 404 });
  }
}
