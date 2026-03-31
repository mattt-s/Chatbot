/**
 * @module auth
 * 用户认证与会话管理模块。
 * 提供 JWT 会话令牌的创建与验证、用户登录认证、以及登录 Cookie 的管理。
 */
import "server-only";

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { findUserByEmail, findUserById } from "@/lib/store";
import type { SessionUser } from "@/lib/types";

const log = createLogger("auth");

const SESSION_COOKIE_NAME = "openclaw-web-session";

function getJwtKey() {
  return new TextEncoder().encode(getEnv().sessionSecret);
}

/**
 * 为用户创建 JWT 会话令牌。
 * @param {SessionUser} user - 需要创建令牌的用户对象
 * @returns {Promise<string>} 签名后的 JWT 字符串，有效期 7 天
 */
export async function createSessionToken(user: SessionUser) {
  return new SignJWT({
    sub: user.id,
    email: user.email,
    displayName: user.displayName,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(getJwtKey());
}

/**
 * 从请求 Cookie 中解析并验证当前登录用户。
 * @returns {Promise<SessionUser | null>} 当前用户信息，未登录或令牌无效时返回 null
 */
export async function getCurrentUser() {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    log.debug("getCurrentUser", { result: "no cookie" });
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getJwtKey());
    if (typeof payload.sub !== "string") {
      log.debug("getCurrentUser", { result: "invalid sub", sub: String(payload.sub) });
      return null;
    }

    const user = await findUserById(payload.sub);
    if (!user) {
      log.debug("getCurrentUser", { result: "user not found", sub: payload.sub });
      return null;
    }

    log.debug("getCurrentUser", { result: "ok", userId: user.id, email: user.email });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    } satisfies SessionUser;
  } catch (err) {
    log.error("getCurrentUser", err);
    return null;
  }
}

/**
 * 获取当前登录用户，未登录时重定向到登录页。
 * @returns {Promise<SessionUser>} 当前用户信息（保证非 null）
 */
export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  return user;
}

/**
 * 验证用户邮箱和密码是否匹配。
 * @param {string} email - 用户邮箱
 * @param {string} password - 明文密码
 * @returns {Promise<SessionUser | null>} 验证成功返回用户信息，失败返回 null
 */
export async function authenticateUser(email: string, password: string) {
  log.input("authenticateUser", { email });
  const user = await findUserByEmail(email);
  if (!user) {
    log.debug("authenticateUser", { result: "user not found", email });
    return null;
  }

  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    log.debug("authenticateUser", { result: "password mismatch", email });
    return null;
  }

  log.output("authenticateUser", { result: "ok", userId: user.id, email: user.email });
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  } satisfies SessionUser;
}

/**
 * 将登录会话 Cookie 写入响应对象。
 * @param {NextResponse} response - Next.js 响应对象
 * @param {SessionUser} user - 已认证的用户信息
 * @returns {Promise<void>}
 */
export async function applyLoginCookie(
  response: NextResponse,
  user: SessionUser,
) {
  const token = await createSessionToken(user);
  const { cookieSecure } = getEnv();
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

/**
 * 清除登录会话 Cookie（用于登出）。
 * @param {NextResponse} response - Next.js 响应对象
 */
export function clearLoginCookie(response: NextResponse) {
  const { cookieSecure } = getEnv();
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: 0,
  });
}
