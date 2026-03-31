/**
 * 服务端数据加载模块
 *
 * 提供页面级数据加载函数，用于在服务端组件中获取仪表盘所需的初始数据。
 */
import "server-only";

import { getChannelView, loadAgentCatalog } from "@/lib/agents";
import { ensureCustomChatBridgeServer } from "@/lib/customchat-bridge-server";
import { ensureDefaultPanel, ensureSeededAdminUser } from "@/lib/store";
import type { DashboardData, SessionUser } from "@/lib/types";

/**
 * 加载仪表盘页面的完整初始数据：确保 Bridge 服务就绪、种子管理员已创建、
 * Agent 目录已加载、用户默认面板已初始化
 * @param {SessionUser} user - 当前登录用户
 * @returns {Promise<DashboardData>} 仪表盘数据（用户信息、Agent 列表、面板列表、频道视图）
 */
export async function loadDashboardData(user: SessionUser): Promise<DashboardData> {
  const [, , agents] = await Promise.all([
    ensureCustomChatBridgeServer().catch(() => null),
    ensureSeededAdminUser(),
    loadAgentCatalog(),
  ]);
  const fallbackAgentId = agents[0]?.id ?? "main";
  const panels = await ensureDefaultPanel(user.id, fallbackAgentId, {
    includeMessages: false,
  });

  return {
    user,
    agents,
    panels,
    channel: getChannelView(),
  };
}
