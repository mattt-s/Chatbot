/**
 * @file 任务模式对话区组件。
 *
 * 展示用户 ↔ Leader 的对话（过滤掉其他成员的消息）。
 * 内置简化版 Composer（无 @-mention，无文件上传，全部发给 Leader）。
 * 完全独立于聊天模式，不复用 message-list.tsx 或 panel-composer.tsx。
 */
"use client";

import { useEffect, useRef, useState } from "react";
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

function MessageBubble({ message }: { message: MessageView }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {/* Avatar */}
      <div
        className={[
          "mt-0.5 h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold",
          isUser
            ? "bg-[var(--ink)] text-white"
            : "bg-[var(--paper-2)] text-[var(--ink)] border border-black/8",
        ].join(" ")}
      >
        {isUser ? "我" : (message.senderLabel?.[0]?.toUpperCase() ?? "L")}
      </div>

      <div
        className={`flex max-w-[76%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
      >
        {/* Sender label (leader only) */}
        {!isUser && message.senderLabel && (
          <span className="text-[11px] text-[var(--ink-soft)]">{message.senderLabel}</span>
        )}

        {/* Bubble */}
        <div
          className={[
            "rounded-2xl px-3 py-2 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-sm bg-[var(--ink)] text-white"
              : "rounded-tl-sm bg-[var(--paper-2)] text-[var(--ink)]",
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
            <div
              className={[
                "prose prose-sm max-w-none break-words",
                "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
                isUser ? "prose-invert" : "",
              ].join(" ")}
            >
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
  isRunActive: boolean;
  isSending: boolean;
  errorMessage: string | null;
  streamStatus: "connecting" | "connected" | "closed";
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
  isRunActive,
  isSending,
  errorMessage,
  streamStatus,
  onSend,
  onClearError,
}: TaskModeConversationProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevLenRef = useRef(0);

  // ── 消息过滤：只展示用户和 leader ──
  const visibleMessages = (() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      // 过滤空壳消息（bridge delivery 噪音）
      if (isBridgeDeliveryMessagePlaceholder(msg)) return false;
      if (msg.role === "user") {
        if (seen.has(msg.id)) return false;
        seen.add(msg.id);
        return true;
      }
      if (msg.role === "assistant") {
        // 无 groupRoleId（直接对话），或 groupRoleId 匹配 leader
        if (!msg.groupRoleId || msg.groupRoleId === leaderRoleId) {
          if (seen.has(msg.id)) return false;
          seen.add(msg.id);
          return true;
        }
      }
      return false;
    });
  })();

  // 新消息到来时滚动到底部
  useEffect(() => {
    if (visibleMessages.length !== prevLenRef.current) {
      prevLenRef.current = visibleMessages.length;
      const list = listRef.current;
      if (list) list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const statusDotCls =
    streamStatus === "connected"
      ? "bg-emerald-500"
      : streamStatus === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-red-400";

  const canSend = Boolean(draft.trim()) && !isSending && !isRunActive;

  return (
    <div className="flex h-full flex-col">
      {/* 顶部状态栏 */}
      <div className="shrink-0 flex items-center gap-1.5 border-b border-black/8 px-4 py-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${statusDotCls}`} />
        <span className="text-[11px] text-[var(--ink-soft)]">用户 ↔ Leader 对话</span>
        {isRunActive && (
          <span className="ml-auto text-[11px] text-[var(--ink-soft)]">处理中…</span>
        )}
      </div>

      {/* 消息列表 */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      >
        {visibleMessages.length === 0 && !isRunActive && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--ink-soft)]">
            <span className="text-2xl">💬</span>
            <span className="text-sm">向 Leader 下达目标或指令</span>
          </div>
        )}
        {visibleMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
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

      {/* 输入框 */}
      <div className="shrink-0 border-t border-black/8 px-3 py-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isRunActive
                ? "Leader 正在处理，请稍候…"
                : "向 Leader 发送指令（Enter 发送，Shift+Enter 换行）"
            }
            disabled={isSending}
            rows={1}
            className={[
              "flex-1 resize-none rounded-2xl border border-black/10 bg-[var(--paper)]",
              "px-3 py-2 text-sm text-[var(--ink)] outline-none transition",
              "placeholder:text-[var(--ink-soft)] focus:border-[var(--accent)]",
              "disabled:opacity-60",
            ].join(" ")}
            style={{ maxHeight: "120px" }}
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            aria-label="发送"
            className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ink)] text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {/* Up arrow icon */}
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
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
  );
}
