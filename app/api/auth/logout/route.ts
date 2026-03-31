/**
 * @file 用户登出接口
 * @description POST /api/auth/logout — 清除登录 Cookie，完成登出
 */
import { NextResponse } from "next/server";

import { clearLoginCookie } from "@/lib/auth";

/**
 * 处理用户登出请求
 * @description 清除当前用户的登录 Cookie。
 * @returns 200 { ok: true }
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearLoginCookie(response);
  return response;
}
