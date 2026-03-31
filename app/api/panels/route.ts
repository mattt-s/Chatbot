/**
 * @file 面板集合接口
 * @description
 *   GET  /api/panels — 获取当前用户的面板列表
 *   POST /api/panels — 创建新面板
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth";
import { createPanel, listPanelsForUser } from "@/lib/store";

const createPanelSchema = z.object({
  agentId: z.string().min(0).default(""),
  title: z.string().min(1).max(100),
  kind: z.enum(["direct", "group"]).optional().default("direct"),
});

/**
 * 获取当前用户的面板列表
 * @description 需要用户登录。返回不包含消息详情的面板摘要列表。
 * @returns 200 PanelView[] | 401 未登录
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    await listPanelsForUser(user.id, {
      includeMessages: false,
    }),
  );
}

/**
 * 创建新面板
 * @description 需要用户登录。需提供 agentId 和 title。
 * @param request - HTTP 请求对象，Body 为 { agentId: string, title: string }
 * @returns 200 新建的面板对象 | 400 参数错误 | 401 未登录
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const json = await request.json().catch(() => null);
  const parsed = createPanelSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数错误。" }, { status: 400 });
  }

  // 群组面板的 agentId 为空字符串
  const agentId = parsed.data.kind === "group" ? "" : parsed.data.agentId;
  if (parsed.data.kind === "direct" && !agentId) {
    return NextResponse.json({ error: "direct 面板需要 agentId。" }, { status: 400 });
  }

  return NextResponse.json(
    await createPanel(user.id, agentId, parsed.data.title, parsed.data.kind),
  );
}
