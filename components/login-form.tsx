/**
 * @file 登录表单组件。
 *
 * 提供 Email + Password 登录界面，通过 `/api/auth/login` 进行认证。
 * 登录成功后跳转到首页。
 */
"use client";

import { startTransition, useState } from "react";

/**
 * 登录表单。
 *
 * 渲染包含 Email 和密码输入框的表单，提交后调用登录 API。
 * 成功时跳转到 `/`，失败时显示错误提示。
 *
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });

    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;

    if (!response.ok) {
      setIsSubmitting(false);
      setErrorMessage(payload?.error ?? "登录失败。");
      return;
    }

    startTransition(() => {
      window.location.href = "/";
    });
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
          Email
        </span>
        <input
          className="w-full rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-base outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[color:color-mix(in_oklab,var(--accent)_18%,white)]"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink-soft)]">
          Password
        </span>
        <input
          className="w-full rounded-2xl border border-black/10 bg-white/80 px-4 py-3 text-base outline-none transition focus:border-[var(--accent)] focus:ring-4 focus:ring-[color:color-mix(in_oklab,var(--accent)_18%,white)]"
          type="password"
          autoComplete="current-password"
          placeholder="输入当前管理员密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>

      {errorMessage ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <button
        className="w-full rounded-2xl bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-[var(--paper)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={isSubmitting}
      >
        {isSubmitting ? "Signing in..." : "进入 Web Channel"}
      </button>
    </form>
  );
}
