/**
 * @file 任务模式对话区组件。
 *
 * 展示用户 ↔ Leader 的对话（过滤掉其他成员的消息）。
 * 内置简化版 Composer（无 @-mention，无文件上传，全部发给 Leader）。
 * 完全独立于聊天模式，不复用 message-list.tsx 或 panel-composer.tsx。
 */
"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { isBridgeDeliveryMessagePlaceholder } from "@/lib/bridge-delivery";
import type { MessageView } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
// 消息气泡
// ─────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MessageBubble({
  message,
  leaderAvatarUrl,
  avatarFailed,
  onAvatarError,
}: {
  message: MessageView;
  leaderAvatarUrl?: string | null;
  avatarFailed: boolean;
  onAvatarError: () => void;
}) {
  const isUser = message.role === "user";
  const initial = (message.senderLabel?.[0]?.toUpperCase() ?? "L");

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"} items-end`}>
      {/* Avatar */}
      <div
        className="mt-0.5 h-8 w-8 shrink-0 rounded-full overflow-hidden flex items-center justify-center text-[11px] font-semibold border border-black/8 bg-white shadow-sm relative"
      >
        {isUser ? (
          <span className="text-[var(--ink-soft)]">我</span>
        ) : leaderAvatarUrl && !avatarFailed ? (
          <Image
            src={leaderAvatarUrl}
            alt={message.senderLabel ?? "Leader"}
            fill
            unoptimized
            sizes="32px"
            className="object-cover"
            onError={onAvatarError}
          />
        ) : (
          <span className="text-xs font-semibold text-[var(--ink-soft)]">{initial}</span>
        )}
      </div>

      <div
        className={`flex max-w-[76%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
      >
        {/* Sender label (leader only) */}
        {!isUser && message.senderLabel && (
          <span className="text-[11px] text-[var(--ink-soft)]">{message.senderLabel}</span>
        )}

        {/* Bubble — 与单聊保持一致 */}
        <div
          className={[
            "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed shadow-sm",
            isUser
              ? "rounded-br-sm bg-[#95ec69] text-[var(--ink)]"
              : "rounded-bl-sm bg-white border border-black/8 text-[var(--ink)]",
          ].join(" ")}
        >
          {/* Typing indicator */}
          {message.draft && !message.text.trim() ? (
            <span className="inline-flex items-center gap-1.5 opacity-60">
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="h-1.5 w-1.5 animate-bounce rounded-full bg-current"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </span>
          ) : (
            <div className="prose prose-sm max-w-none break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.text}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {/* Error */}
        {message.errorMessage && (
          <span className="text-[11px] text-red-600">{message.errorMessage}</span>
        )}

        {/* Timestamp */}
        <span className="text-[10px] text-[var(--ink-soft)]">{fmtTime(message.createdAt)}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 主组件
// ─────────────────────────────────────────────────────────────

export interface TaskModeConversationProps {
  messages: MessageView[];
  /** leader 角色 ID，用于过滤只展示 leader 消息 */
  leaderRoleId: string | null;
  /** leader 头像 URL，用于展示头像图片 */
  leaderAvatarUrl?: string | null;
  isRunActive: boolean;
  isSending: boolean;
  errorMessage: string | null;
  onSend: (text: string) => Promise<void>;
  onClearError: () => void;
}

/**
 * 任务模式对话区。
 * 过滤规则：展示 user 消息 + groupRoleId===leaderRoleId 的 assistant 消息，其余隐藏。
 */
export function TaskModeConversation({
  messages,
  leaderRoleId,
  leaderAvatarUrl,
  isRunActive,
  isSending,
  errorMessage,
  onSend,
  onClearError,
}: TaskModeConversationProps) {
  const [draft, setDraft] = useState("");
  const [leaderAvatarFailed, setLeaderAvatarFailed] = useState(false);
  // 切换面板时重置头像失败状态 & 初始滚动标记
  useEffect(() => {
    setLeaderAvatarFailed(false);
    initialScrollDoneRef.current = false;
    prevLenRef.current = 0;
  }, [leaderRoleId]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevLenRef = useRef(0);
  // 首次加载完成后才允许 smooth 滚动；避免初始化时一条条 smooth 滚动的视觉刷屏
  const initialScrollDoneRef = useRef(false);

  // ── 消息过滤：只展示用户和 leader ──
  const visibleMessages = (() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (isBridgeDeliveryMessagePlaceholder(msg)) return false;
      // 用 role:id 作去重 key，防止 user 消息和 assistant 消息因共用相同 id 互相屏蔽
      // （task 模式下 messageId 可能同时作为 user 消息 id 和 agent 回复 runId）
      const key = `${msg.role}:${msg.id}`;
      if (msg.role === "user") {
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }
      if (msg.role === "assistant") {
        if (!msg.groupRoleId || msg.groupRoleId === leaderRoleId) {
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }
      }
      return false;
    });
  })();

  // 消息变化时滚动到底部
  // - 首次加载（initialScrollDoneRef=false）：instant，直接跳底部
  // - 后续新消息：smooth，平滑滚动
  useEffect(() => {
    if (visibleMessages.length === prevLenRef.current) return;
    prevLenRef.current = visibleMessages.length;
    const list = listRef.current;
    if (!list) return;
    if (!initialScrollDoneRef.current) {
      // 初始批量加载：直接跳到底部，无动画
      list.scrollTop = list.scrollHeight;
      initialScrollDoneRef.current = true;
    } else {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    }
  }, [visibleMessages.length]);

  // Textarea 自动增高
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [draft]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || isSending || isRunActive) return;
    setDraft("");
    await onSend(text);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 拼音输入法合成中（isComposing）时按 Enter 不发送，与单聊保持一致
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  }

  const canSend = Boolean(draft.trim()) && !isSending && !isRunActive;

  return (
    <div className="flex h-full flex-col">
      {/* 消息列表 */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {visibleMessages.length === 0 && !isRunActive && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--ink-soft)]">
            <span className="text-2xl">💬</span>
            <span className="text-sm">与 Leader 交流</span>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            leaderAvatarUrl={leaderAvatarUrl}
            avatarFailed={leaderAvatarFailed}
            onAvatarError={() => setLeaderAvatarFailed(true)}
          />
        ))}
      </div>

      {/* 错误提示 */}
      {errorMessage && (
        <div className="mx-4 mb-2 flex items-center justify-between gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 border border-red-200">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={onClearError}
            className="shrink-0 text-red-400 hover:text-red-600"
          >
            ✕
          </button>
        </div>
      )}

      {/* 输入框 — 与单聊保持一致：卡片容器 + 发送按钮内嵌右下角 */}
      <div className="shrink-0 border-t border-black/8 p-3">
        <div className="relative rounded-2xl border border-black/10 bg-[var(--paper)] transition focus-within:border-[var(--accent)]">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunActive ? "Leader 处理中…" : "与 Leader 交流"}
            disabled={isSending || isRunActive}
            rows={1}
            className={[
              "w-full resize-none bg-transparent px-3.5 pb-10 pt-2.5",
              "text-sm text-[var(--ink)] outline-none",
              "placeholder:text-xs placeholder:text-[var(--ink-soft)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            ].join(" ")}
            style={{ maxHeight: "120px" }}
          />
          {/* 右下角操作区 */}
          <div className="absolute bottom-2 right-2 flex items-center gap-2">
            {isRunActive && (
              <span className="text-[10px] text-[var(--ink-soft)]">处理中…</span>
            )}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              aria-label="发送"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] text-white transition hover:opacity-90 disabled:opacity-40"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
