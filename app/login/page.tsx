/**
 * @file 登录页面
 * @description /login — 用户登录页面，包含品牌介绍和登录表单。已登录用户重定向到首页。
 */
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeededAdminUser } from "@/lib/store";

/**
 * 登录页面服务端组件
 * @description 确保管理员种子用户存在，已登录则重定向到首页，否则渲染登录表单。
 * @returns 登录页面 UI | 重定向到 /
 */
export default async function LoginPage() {
  await ensureSeededAdminUser();
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  return (
    <main className="flex h-[100svh] items-stretch justify-center overflow-hidden bg-[var(--canvas)] px-3 py-3 md:min-h-screen md:items-center md:px-4 md:py-6">
      <section className="grid h-full w-full max-w-5xl overflow-hidden rounded-[28px] border border-black/8 bg-[var(--paper)] shadow-[0_24px_100px_rgba(12,18,28,0.08)] md:h-auto md:rounded-[36px] md:grid-cols-[1.1fr_0.9fr]">
        <div className="relative overflow-hidden bg-[var(--ink)] px-5 py-4 text-[var(--paper)] md:px-10 md:py-12">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,139,45,0.45),_transparent_32%),radial-gradient(circle_at_bottom_right,_rgba(64,216,196,0.28),_transparent_35%)]" />
          <div className="relative">
            <div className="text-[10px] uppercase tracking-[0.22em] text-white/70 md:text-[11px] md:tracking-[0.28em]">
              Provider-style Web Channel
            </div>
            <h1 className="mt-3 text-xl font-semibold leading-tight sm:text-2xl md:mt-5 md:text-5xl">
              把门户变成一个被动接收消息的独立 channel。
            </h1>
            <p className="mt-2 max-w-xl text-xs leading-5 text-white/75 sm:text-sm sm:leading-6 md:mt-5 md:text-base md:leading-7">
              这里保留本地账号体系、文件上传入口、多面板角色窗口和 SSE
              更新流，但不再由 app 主动连接 OpenClaw Gateway。
            </p>

            <div className="mt-4 space-y-2 text-xs text-white/80 md:mt-8 md:space-y-3 md:text-sm">
              <div className="rounded-[18px] border border-white/15 bg-white/6 px-3 py-2 md:rounded-[24px] md:px-4 md:py-4">
                认证：Cookie Session + 本地用户存储
              </div>
              <div className="hidden rounded-[24px] border border-white/15 bg-white/6 px-4 py-4 md:block">
                架构：Slack-style 外部 provider channel
              </div>
              <div className="hidden rounded-[24px] border border-white/15 bg-white/6 px-4 py-4 md:block">
                UI：每个窗口绑定一个独立 panel target
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 md:px-10 md:py-12">
          <div className="max-w-md">
            <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-soft)] md:text-[11px] md:tracking-[0.24em]">
              Sign In
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ink)] md:mt-3 md:text-3xl">
              进入控制台
            </h2>
            <div className="mt-4 md:mt-8">
              <LoginForm />
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
