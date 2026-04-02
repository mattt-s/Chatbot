/**
 * @file 聊天消息气泡组件。
 *
 * 负责渲染单条用户或助手消息，包含文本内容、附件预览（图片/音频/视频）、
 * runtime 步骤折叠详情、流式状态指示器等。
 * 支持仿微信的连续消息分组显示（圆角与头像仅在组首/组尾出现）。
 */
"use client";

import { memo, useState } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { AttachmentView, MessageSessionMeta, MessageView } from "@/lib/types";
import { formatBytes } from "@/lib/utils";
import { formatTimeLabel } from "./chat-helpers";
import type { RuntimeStep } from "./runtime-helpers";
import {
  isAssistantTextStep,
  isIgnorableRuntimeStep,
  normalizeRuntimeStepForDisplay,
} from "./runtime-helpers";

function normalizeMarkdownText(text: string) {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const normalizedLines = rawLines.map((line) => {
    const numberedMatch = line.match(/^(\s*)(\d+)[）)][\s\u3000]*(.+)$/);
    if (numberedMatch) {
      const [, indent, order, content] = numberedMatch;
      return `${indent}${order}. ${content}`;
    }

    const wrappedNumberedMatch = line.match(/^(\s*)[（(](\d+)[）)][\s\u3000]*(.+)$/);
    if (wrappedNumberedMatch) {
      const [, indent, order, content] = wrappedNumberedMatch;
      return `${indent}${order}. ${content}`;
    }

    return line;
  });

  const result: string[] = [];
  let inOrderedList = false;

  function isOrderedItem(line: string) {
    return /^\s*\d+\.\s+/.test(line);
  }

  for (let index = 0; index < normalizedLines.length; index += 1) {
    const line = normalizedLines[index];
    const trimmed = line.trim();
    const orderedItem = isOrderedItem(line);

    if (orderedItem) {
      if (result.length > 0) {
        const previous = result[result.length - 1] ?? "";
        if (!inOrderedList) {
          result[result.length - 1] = previous.replace(/[ \t]{2,}$/, "");
        }
      }

      result.push(line.replace(/[ \t]{2,}$/, ""));
      inOrderedList = true;
      continue;
    }

    if (trimmed === "") {
      const nextNonEmpty = normalizedLines.slice(index + 1).find((candidate) => candidate.trim() !== "");
      if (
        nextNonEmpty &&
        isOrderedItem(nextNonEmpty) &&
        result.length > 0 &&
        result[result.length - 1]?.trim() !== ""
      ) {
        continue;
      }

      if (inOrderedList) {
        if (nextNonEmpty && isOrderedItem(nextNonEmpty)) {
          continue;
        }
      }

      if (result[result.length - 1] !== "") {
        result.push("");
      }
      inOrderedList = false;
      continue;
    }

    if (inOrderedList) {
      result.push("");
      inOrderedList = false;
    }

    result.push(line);
  }

  while (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }

  return result.join("\n");
}

/**
 * 附件预览子组件。
 *
 * 根据附件类型渲染图片、音频或视频的预览元素。
 * 图片支持点击放大预览，加载失败时显示提示。
 *
 * @param props.attachment - 附件视图对象
 * @param props.onPreview - 图片点击时的预览回调
 */
function AttachmentPreview({
  attachment, 
  onPreview 
}: { 
  attachment: AttachmentView; 
  onPreview?: (url: string) => void;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  if (attachment.kind === "image") {
    if (loadFailed) {
      return (
        <div className="rounded-[16px] border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          图片暂时不可读取。通常是附件 URL 仍指向外部 provider 的临时地址，当前 Web 服务无法直接读取。
        </div>
      );
    }

    return (
      // Attachment URLs may point to transient provider-backed media, so keep a plain img.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={attachment.url}
        alt={attachment.name}
        onError={() => setLoadFailed(true)}
        onClick={() => onPreview?.(attachment.url)}
        className="max-h-72 w-full cursor-zoom-in rounded-[20px] border border-black/8 bg-[var(--paper-2)] object-contain transition-opacity hover:opacity-95"
      />
    );
  }

  if (attachment.kind === "audio") {
    return <audio controls className="w-full" src={attachment.url} preload="metadata" />;
  }

  if (attachment.kind === "video") {
    return (
      <video
        controls
        className="max-h-80 w-full rounded-[20px] border border-black/8 bg-black"
        src={attachment.url}
      />
    );
  }

  return null;
}

function AttachmentActionMenu({ attachment }: { attachment: AttachmentView }) {
  return (
    <details className="group relative inline-block max-w-full">
      <summary className="flex cursor-pointer list-none rounded-2xl border border-black/10 bg-white/80 px-3 py-2 text-left text-xs text-[var(--ink)] transition hover:border-[var(--accent)]">
        <span className="min-w-0 pr-4">
          <span className="block truncate font-semibold">{attachment.name}</span>
          <span className="block text-[var(--ink-soft)]">
            {attachment.kind} · {formatBytes(attachment.size)}
          </span>
          {attachment.kind === "audio" && attachment.localPath ? (
            <span className="mt-1 block break-all text-[10px] text-[var(--ink-soft)]">
              {attachment.localPath}
            </span>
          ) : null}
        </span>
        <span
          aria-hidden
          className="ml-auto shrink-0 self-center text-[11px] text-[var(--ink-soft)] transition group-open:rotate-180"
        >
          ▾
        </span>
      </summary>

      <div className="absolute left-0 top-[calc(100%+0.5rem)] z-10 min-w-[144px] overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-[0_16px_40px_rgba(15,23,36,0.16)]">
        <a
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          className="block rounded-xl px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
        >
          打开
        </a>
        <a
          href={attachment.url}
          download={attachment.name}
          className="mt-1 block rounded-xl px-3 py-2 text-xs font-medium text-[var(--ink)] transition hover:bg-[var(--paper-2)]"
        >
          保存
        </a>
      </div>
    </details>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  const normalizedText = normalizeMarkdownText(text);

  return (
    <div className="min-w-0 max-w-full text-sm leading-6 text-[var(--ink)] [overflow-wrap:anywhere]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 text-2xl font-semibold leading-8 text-[var(--ink)]">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 text-xl font-semibold leading-7 text-[var(--ink)]">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 text-lg font-semibold leading-7 text-[var(--ink)]">{children}</h3>
          ),
          p: ({ children }) => <p className="mb-3 whitespace-pre-wrap last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-1.5 list-disc pl-5 last:mb-0 [&_ul]:mb-0 [&_ol]:mb-0">{children}</ul>,
          ol: ({ children, start }) => (
            <ol start={start} className="mb-1.5 list-decimal pl-5 last:mb-0 [&_ul]:mb-0 [&_ol]:mb-0">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="mb-0.5 last:mb-0 [&>p]:mb-0 [&>ul]:mt-1 [&>ol]:mt-1">
              {children}
            </li>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-4 border-black/10 pl-3 text-[var(--ink-soft)] last:mb-0">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-sky-700 underline decoration-sky-500 underline-offset-2 hover:text-sky-800"
            >
              {children}
            </a>
          ),
          pre: ({ children }) => (
            <pre className="mb-3 max-w-full overflow-x-auto rounded-lg bg-black/5 px-3 py-2 font-mono text-[11px] leading-5 text-[var(--ink)] last:mb-0">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const isBlock = Boolean(className);
            if (isBlock) {
              return <code className={className}>{children}</code>;
            }
            return (
              <code className="rounded bg-black/5 px-1 py-0.5 font-mono text-[12px] text-[var(--ink)]">
                {children}
              </code>
            );
          },
          hr: () => <hr className="my-4 border-black/10" />,
          table: ({ children }) => (
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="min-w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-black/10 bg-black/5 px-2 py-1 font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-black/10 px-2 py-1 align-top">{children}</td>,
        }}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
}

function compactTokenCount(value: number) {
  if (value < 1000) {
    return String(value);
  }

  const kilo = value / 1000;
  if (kilo >= 100 || Number.isInteger(kilo)) {
    return `${Math.round(kilo)}k`;
  }

  return `${kilo.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatSessionMeta(status: MessageSessionMeta | null | undefined) {
  if (!status) {
    return [];
  }

  const parts: string[] = [];
  if (status.model) {
    parts.push(status.model);
  }

  if (status.contextUsedTokens != null && status.contextMaxTokens != null) {
    const percent =
      status.contextPercent != null
        ? ` (${status.contextPercent}%)`
        : "";
    parts.push(
      `${compactTokenCount(status.contextUsedTokens)}/${compactTokenCount(status.contextMaxTokens)}${percent}`,
    );
  }

  if (status.compactions != null && status.compactions > 0) {
    parts.push(`cpt: ${status.compactions}`);
  }

  return parts;
}

/**
 * 单条聊天消息气泡。
 *
 * 渲染一条完整的聊天消息，包括角色标签、时间、文本内容、
 * runtime 工具调用步骤、附件列表、流式/错误状态。
 * 通过 `isGroupStart`/`isGroupEnd` 控制连续消息的分组圆角和头像可见性。
 *
 * @param props.message - 消息数据
 * @param props.userRoleName - 用户角色显示名
 * @param props.assistantRoleName - 助手角色显示名
 * @param props.agentAvatarUrl - Agent 头像 URL
 * @param props.runtimeSteps - 关联的 runtime 步骤列表
 * @param props.isGroupStart - 是否为连续同角色消息组的首条
 * @param props.isGroupEnd - 是否为连续同角色消息组的末条
 * @param props.onPreview - 图片预览回调
 */
function MessageBubbleComponent({
  message,
  hideNoiseText,
  userRoleName,
  assistantRoleName,
  agentAvatarUrl,
  runtimeSteps,
  isGroupStart,
  isGroupEnd,
  onPreview,
  isGroupPanel,
  groupRoleLabel,
  groupRoleEmoji,
  groupRoleAgentEmoji,
  groupRoleAvatarUrl,
  groupRoleIndex,
  mentionedRoles,
}: {
  message: MessageView;
  hideNoiseText?: boolean;
  userRoleName: string;
  assistantRoleName: string;
  agentAvatarUrl?: string | null;
  runtimeSteps: RuntimeStep[];
  isGroupStart?: boolean;
  isGroupEnd?: boolean;
  onPreview?: (url: string) => void;
  /** 是否处于群组面板 */
  isGroupPanel?: boolean;
  /** 群组消息：角色显示名 */
  groupRoleLabel?: string | null;
  /** 群组消息：角色 emoji */
  groupRoleEmoji?: string | null;
  /** 群组消息：角色绑定 agent 的 emoji */
  groupRoleAgentEmoji?: string | null;
  /** 群组消息：角色绑定 agent 的头像 */
  groupRoleAvatarUrl?: string | null;
  /** 群组消息：角色在列表中的序号（从1开始），用于默认头像 */
  groupRoleIndex?: number;
  /** 群组消息：被 @mention 的角色列表 */
  mentionedRoles?: Array<{ label: string; emoji: string | null }>;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const visibleMessageText = hideNoiseText ? "" : message.text;
  const hasRuntimeSteps = isAssistant && runtimeSteps.length > 0;
  const sortedRuntimeSteps = hasRuntimeSteps
    ? runtimeSteps
        .filter((step) => !isIgnorableRuntimeStep(step))
        .map(normalizeRuntimeStepForDisplay)
        .sort((left, right) => left.ts - right.ts)
    : [];
  const hasAssistantTextStep = sortedRuntimeSteps.some((step) => isAssistantTextStep(step));
  const shouldDeferAssistantText =
    hasRuntimeSteps && message.draft && !visibleMessageText && !hasAssistantTextStep;
  const shouldHideEmptyPlaceholder =
    !message.draft &&
    !visibleMessageText &&
    (hasRuntimeSteps || message.attachments.length > 0);
  // 群组面板中，助手消息使用角色名作为标签
  const effectiveAssistantLabel =
    isGroupPanel && groupRoleLabel ? groupRoleLabel : assistantRoleName;
  const effectiveGroupEmoji = groupRoleEmoji ?? groupRoleAgentEmoji ?? null;
  const effectiveGroupLabel = isGroupPanel
    ? `${effectiveAssistantLabel}${effectiveGroupEmoji ? ` ${effectiveGroupEmoji}` : ""}`
    : effectiveAssistantLabel;

  const roleLabel = isUser
    ? userRoleName
    : isAssistant
      ? (isGroupPanel && message.senderLabel
          ? `${message.senderLabel}${effectiveGroupEmoji ? ` ${effectiveGroupEmoji}` : ""}`
          : effectiveGroupLabel)
      : "System";
  const sessionMetaParts = isAssistant ? formatSessionMeta(message.sessionMeta) : [];

  const groupAvatarContent = groupRoleAvatarUrl ? (
    <Image
      src={groupRoleAvatarUrl}
      alt={effectiveGroupLabel || assistantRoleName}
      fill
      unoptimized
      sizes="36px"
      className="object-cover"
    />
  ) : effectiveGroupEmoji ? (
    <span className="text-sm">{effectiveGroupEmoji}</span>
  ) : (
    <span className="text-xs font-semibold text-[var(--ink-soft)]">
      {groupRoleIndex != null ? String(groupRoleIndex) : (effectiveAssistantLabel || "A").slice(0, 1)}
    </span>
  );

  const avatarContent = isGroupPanel && isAssistant ? groupAvatarContent : agentAvatarUrl ? (
    <Image
      src={agentAvatarUrl}
      alt={assistantRoleName}
      fill
      unoptimized
      sizes="36px"
      className="object-cover"
    />
  ) : (
    <span className="text-xs font-semibold text-[var(--ink-soft)]">
      {(assistantRoleName || "A").slice(0, 1)}
    </span>
  );

  return (
    <div className={`flex min-w-0 ${isUser ? "justify-end" : "justify-start"} ${isGroupStart ? "mt-4" : "mt-0"}`}>
      {isAssistant ? (
        <div 
          className={`relative mr-2 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-black/8 bg-white shadow-sm self-end ${
            isGroupEnd ? "opacity-100" : "opacity-0 invisible"
          }`}
          style={{ marginBottom: "2px" }}
        >
          {avatarContent}
        </div>
      ) : null}
      <div className="min-w-0 max-w-[92%] sm:max-w-[86%]">
        <div
          className={`relative min-w-0 rounded-2xl px-4 py-3 text-[var(--ink)] shadow-sm ${
            isUser
              ? `bg-[#95ec69] ${!isGroupEnd ? "rounded-br-sm" : ""} ${!isGroupStart ? "rounded-tr-sm" : ""}`
              : `border border-black/8 bg-white ${!isGroupEnd ? "rounded-bl-sm" : ""} ${!isGroupStart ? "rounded-tl-sm" : ""}`
          }`}
        >
          {isGroupEnd && (
            <span
              aria-hidden
              className={`absolute bottom-3 h-3 w-3 rotate-45 ${
                isUser
                  ? "-right-1 bg-[#95ec69]"
                  : "-left-1 border-b border-l border-black/8 bg-white"
              }`}
            />
          )}

          {hasRuntimeSteps ? (
            <div className="mb-3 min-w-0 space-y-2">
              {sortedRuntimeSteps.map((step) =>
                isAssistantTextStep(step) ? (
                  <div
                    key={step.id}
                    className="min-w-0 max-w-full break-words font-sans [overflow-wrap:anywhere]"
                  >
                    <MarkdownMessage text={step.detail ?? step.description} />
                  </div>
                ) : (
                  <details
                    key={step.id}
                    className="min-w-0 max-w-full overflow-hidden rounded-xl border border-black/8 bg-[var(--paper-2)] px-3 py-2"
                  >
                    <summary className="block cursor-pointer list-none break-words text-xs font-medium text-[var(--ink)] [overflow-wrap:anywhere]">
                      <span className="mr-1">
                        {step.kind === "exec"
                          ? "🛠"
                          : step.kind === "write"
                            ? "✍️"
                            : step.kind === "read"
                              ? "📖"
                              : step.kind === "edit"
                                ? "📝"
                                : step.kind === "search"
                                  ? "🔎"
                                  : step.kind === "process"
                                    ? "🧰"
                                    : "⚙️"}
                      </span>
                      {step.title}: {step.description}
                    </summary>

                    {step.detail ? (
                      <pre className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 px-2 py-2 font-mono text-[11px] leading-5 text-[var(--ink)] [overflow-wrap:anywhere]">
                        {step.detail}
                      </pre>
                    ) : (
                      <div className="mt-2 text-[11px] text-[var(--ink-soft)]">
                        {step.status === "error"
                          ? "Failed"
                          : step.status === "running"
                            ? "Running"
                            : step.status === "done"
                              ? "Completed"
                              : "Updated"}
                      </div>
                    )}
                  </details>
                ),
              )}
            </div>
          ) : null}

          {shouldDeferAssistantText ? (
            <p className="text-sm text-[var(--ink-soft)]">执行中，等待最终结果...</p>
          ) : shouldHideEmptyPlaceholder ? null : visibleMessageText && !hasAssistantTextStep ? (
            <div className="min-w-0 max-w-full break-words font-sans [overflow-wrap:anywhere]">
              <MarkdownMessage text={visibleMessageText} />
            </div>
          ) : message.state === "error" ? (
            <p className="text-sm text-red-700">{message.errorMessage}</p>
          ) : (
            <p className="text-sm text-[var(--ink-soft)]">等待内容...</p>
          )}

          {message.attachments.length > 0 ? (
            <div className="mt-4 space-y-3">
              {message.attachments.map((attachment) => (
                <div key={attachment.id} className="space-y-2">
                  <AttachmentPreview attachment={attachment} onPreview={onPreview} />
                  {attachment.kind === "image" ? (
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded-2xl border border-black/10 bg-white/80 px-3 py-2 text-xs text-[var(--ink)] transition hover:border-[var(--accent)]"
                    >
                      <span>
                        <span className="block font-semibold">{attachment.name}</span>
                        <span className="block text-[var(--ink-soft)]">
                          {attachment.kind} · {formatBytes(attachment.size)}
                        </span>
                      </span>
                    </a>
                  ) : (
                    <AttachmentActionMenu attachment={attachment} />
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {message.draft ? (
            <div className="mt-3 text-xs font-medium text-[var(--ink-soft)]">
              Streaming...
            </div>
          ) : null}

          {message.stopReason ? (
            <div className="mt-3 text-xs text-[var(--ink-soft)]">
              stop reason: {message.stopReason}
            </div>
          ) : null}

          {isGroupPanel && mentionedRoles && mentionedRoles.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
              {mentionedRoles.map((role) => (
                <span
                  key={role.label}
                  className="inline-flex items-center rounded-full bg-[var(--paper-2)] px-2 py-0.5 text-[10px] font-medium text-[var(--ink-soft)]"
                >
                  @{role.label}{role.emoji ? ` ${role.emoji}` : ""}
                </span>
              ))}
            </div>
          ) : null}

        </div>

        {isGroupEnd ? (
          <div
            className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-[var(--ink-soft)] ${
              isUser ? "justify-end text-right" : "justify-start text-left"
            }`}
          >
            <span>{roleLabel}</span>
            <span aria-hidden>·</span>
            <time suppressHydrationWarning>{formatTimeLabel(message.createdAt)}</time>
            {sessionMetaParts.map((part) => (
              <span key={part} className="contents">
                <span aria-hidden>·</span>
                <span>{part}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function sameMentionedRoles(
  left?: Array<{ label: string; emoji: string | null }>,
  right?: Array<{ label: string; emoji: string | null }>,
) {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) =>
      item.label === right[index]?.label &&
      item.emoji === right[index]?.emoji,
  );
}

export const MessageBubble = memo(MessageBubbleComponent, (prev, next) => {
  return (
    prev.message === next.message &&
    prev.hideNoiseText === next.hideNoiseText &&
    prev.userRoleName === next.userRoleName &&
    prev.assistantRoleName === next.assistantRoleName &&
    prev.agentAvatarUrl === next.agentAvatarUrl &&
    prev.runtimeSteps === next.runtimeSteps &&
    prev.isGroupStart === next.isGroupStart &&
    prev.isGroupEnd === next.isGroupEnd &&
    prev.onPreview === next.onPreview &&
    prev.isGroupPanel === next.isGroupPanel &&
    prev.groupRoleLabel === next.groupRoleLabel &&
    prev.groupRoleEmoji === next.groupRoleEmoji &&
    prev.groupRoleAgentEmoji === next.groupRoleAgentEmoji &&
    prev.groupRoleAvatarUrl === next.groupRoleAvatarUrl &&
    prev.groupRoleIndex === next.groupRoleIndex &&
    sameMentionedRoles(prev.mentionedRoles, next.mentionedRoles)
  );
});
