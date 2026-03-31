/**
 * @file 代理列表接口
 * @description GET /api/agents — 获取可用的代理目录列表
 */
import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { loadAgentCatalog } from "@/lib/agents";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * 获取代理目录列表
 * @description 需要用户登录。支持 ?refresh=true 查询参数强制刷新缓存。
 * @param request - HTTP 请求对象，可携带 refresh 查询参数
 * @returns 200 { agents: AgentView[] } | 401 未登录
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const forceRefresh = searchParams.get("refresh") === "true";
  const agents = await loadAgentCatalog(forceRefresh);

  return NextResponse.json(
    {
      agents,
    },
    {
      headers: {
        "Cache-Control": "private, max-age=60",
      },
    },
  );
}
