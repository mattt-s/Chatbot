/**
 * @file 首页（仪表盘）
 * @description 应用主页面，展示多面板聊天工作区。未登录用户重定向到 /login。
 */
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard-shell";
import { getCurrentUser } from "@/lib/auth";
import { loadDashboardData } from "@/lib/server-data";

export const revalidate = 5;

/**
 * 首页服务端组件
 * @description 校验登录状态，加载仪表盘数据后渲染 DashboardShell。
 * @returns DashboardShell 组件 | 重定向到 /login
 */
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const data = await loadDashboardData(user);
  return <DashboardShell initialData={data} />;
}
