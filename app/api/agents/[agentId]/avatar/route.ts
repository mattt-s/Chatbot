/**
 * @file 代理头像代理接口
 * @description GET /api/agents/[agentId]/avatar — 从 Provider 获取指定代理的头像图片并透传给前端
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type RouteContext = {
  params: Promise<{
    agentId: string;
  }>;
};

/**
 * 获取指定代理的头像图片
 * @description 需要用户登录。从 Provider 拉取头像二进制数据并以原始 Content-Type 返回。
 * @param _request - HTTP 请求对象（未使用）
 * @param context - 路由上下文，包含 agentId 路径参数
 * @returns 200 头像二进制数据 | 401 未登录 | 404 头像未找到 | 503 Provider 不可用
 */
export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await context.params;
  const env = getEnv();
  if (!env.providerBaseUrl || !env.customChatAuthToken) {
    return NextResponse.json({ error: "Provider unavailable." }, { status: 503 });
  }

  const response = await fetch(
    `${env.providerBaseUrl.replace(/\/+$/, "")}/customchat/agent-avatar?agentId=${encodeURIComponent(agentId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.customChatAuthToken}`,
      },
      cache: "no-store",
    },
  ).catch(() => null);

  if (!response?.ok) {
    return NextResponse.json({ error: "Avatar not found." }, { status: 404 });
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = await response.arrayBuffer();
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300",
    },
  });
}
