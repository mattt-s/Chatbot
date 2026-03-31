/**
 * @file 用户登录接口
 * @description POST /api/auth/login — 验证邮箱和密码，成功后设置登录 Cookie
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { applyLoginCookie, authenticateUser } from "@/lib/auth";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * 处理用户登录请求
 * @description 无需认证。验证邮箱密码，成功后在响应中设置 Session Cookie。
 * @param request - HTTP 请求对象，Body 为 { email: string, password: string }
 * @returns 200 { ok: true, user } 登录成功 | 400 参数格式错误 | 401 账号或密码不正确
 */
export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "请输入正确的邮箱和密码。" },
      { status: 400 },
    );
  }

  const user = await authenticateUser(parsed.data.email, parsed.data.password);
  if (!user) {
    return NextResponse.json(
      { error: "账号或密码不正确。" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({ ok: true, user });
  await applyLoginCookie(response, user);
  return response;
}
