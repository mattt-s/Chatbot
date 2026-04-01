/**
 * @file 消息输入框（Composer）组件。
 *
 * 聊天面板底部的消息编辑区域，包含文本输入、文件上传、发送按钮。
 * 在移动端和桌面端有不同的交互模式（紧凑模式 vs 展开模式）。
 */
"use client";

import { RefObject, Dispatch, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView, GroupRoleView } from "@/lib/types";

const VOICE_INPUT_FILENAME_PREFIX = "__voice-input__";

function isVoiceInputFile(file: File) {
  return file.type.startsWith("audio/") && file.name.startsWith(VOICE_INPUT_FILENAME_PREFIX);
}

/**
 * PanelComposer 的 Props。
 */
interface PanelComposerProps {
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  selectedMentionRoleIds: string[];
  setSelectedMentionRoleIds: Dispatch<SetStateAction<string[]>>;
  selectedFiles: File[];
  setSelectedFiles: Dispatch<SetStateAction<File[]>>;
  isSending: boolean;
  isRunActive: boolean;
  isMobileInputMode: boolean;
  mobileComposerExpanded: boolean;
  setMobileComposerExpanded: Dispatch<SetStateAction<boolean>>;
  composerFocused: boolean;
  setComposerFocused: Dispatch<SetStateAction<boolean>>;
  hasComposerContent: boolean;
  displayAssistantRoleName: string;
  errorMessage: string | null;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  composerFormRef: RefObject<HTMLFormElement | null>;
  messageListRef: RefObject<HTMLDivElement | null>;
  onSend: (event: React.FormEvent<HTMLFormElement>) => void;
  /** 群组面板：角色列表，用于 @ 自动补全 */
  groupRoles?: GroupRoleView[];
  /** 群组面板：agent 列表，用于 emoji 回退 */
  agents?: AgentView[];
  /** 是否为群组面板 */
  isGroupPanel?: boolean;
}

/**
 * 面板消息输入框。
 *
 * 渲染消息编辑区域，包含可自适应高度的文本框、文件上传按钮、
 * 已选文件列表和发送按钮。桌面端按 Enter 发送，移动端有紧凑/展开两种布局。
 * 单文件上传限制为 10MB。
 *
 * @param props - 参见 PanelComposerProps
 */
export function PanelComposer({
  draft,
  setDraft,
  selectedMentionRoleIds,
  setSelectedMentionRoleIds,
  selectedFiles,
  setSelectedFiles,
  isSending,
  isRunActive,
  isMobileInputMode,
  mobileComposerExpanded,
  setMobileComposerExpanded,
  composerFocused,
  setComposerFocused,
  hasComposerContent,
  displayAssistantRoleName,
  errorMessage,
  setErrorMessage,
  composerFormRef,
  messageListRef,
  onSend,
  groupRoles,
  agents,
  isGroupPanel,
}: PanelComposerProps) {
  const composerExpanded = isMobileInputMode
    ? mobileComposerExpanded || hasComposerContent
    : composerFocused || hasComposerContent;
  const composerCompactMobile = isMobileInputMode && !composerExpanded;
  const sendBlockedByRun = !isGroupPanel && isRunActive;
  const sendDisabled = isSending || sendBlockedByRun;
  const sendButtonLabel = isSending ? "发送中..." : sendBlockedByRun ? "推理中..." : "发送";

  // @ 自动补全
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const mediaChunksRef = useRef<Blob[]>([]);

  const enabledRoles = useMemo(
    () => (groupRoles ?? []).filter((r) => r.enabled),
    [groupRoles],
  );

  const agentMap = useMemo(() => {
    const map = new Map<string, AgentView>();
    (agents ?? []).forEach((agent) => {
      map.set(agent.id, agent);
    });
    return map;
  }, [agents]);

  const selectedMentionRoles = useMemo(
    () =>
      selectedMentionRoleIds
        .map((roleId) => {
          const role = enabledRoles.find((candidate) => candidate.id === roleId);
          if (!role) return null;
          return {
            role,
            emoji: role.emoji ?? agentMap.get(role.agentId)?.emoji ?? null,
          };
        })
        .filter(
          (entry): entry is { role: GroupRoleView; emoji: string | null } => Boolean(entry),
        ),
    [agentMap, enabledRoles, selectedMentionRoleIds],
  );
  const voiceInputFiles = useMemo(
    () => selectedFiles.filter((file) => isVoiceInputFile(file)),
    [selectedFiles],
  );
  const regularSelectedFiles = useMemo(
    () => selectedFiles.filter((file) => !isVoiceInputFile(file)),
    [selectedFiles],
  );
  const hasVoiceInput = voiceInputFiles.length > 0;
  const latestVoiceInputFile = voiceInputFiles[voiceInputFiles.length - 1] ?? null;
  const [voicePreviewUrl, setVoicePreviewUrl] = useState<string | null>(null);

  const mentionCandidates = useMemo(() => {
    if (!isGroupPanel || mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return enabledRoles.filter(
      (role) =>
        !selectedMentionRoleIds.includes(role.id) &&
        role.title.toLowerCase().includes(q),
    );
  }, [enabledRoles, isGroupPanel, mentionQuery, selectedMentionRoleIds]);

  const checkMentionTrigger = useCallback(
    (text: string, cursorPos: number) => {
      if (!isGroupPanel) return;
      // 找光标前最近的 @
      const before = text.slice(0, cursorPos);
      const atIdx = before.lastIndexOf("@");
      if (atIdx === -1) {
        setMentionQuery(null);
        return;
      }
      // @ 前面必须是空白或行首
      if (atIdx > 0 && !/\s/.test(before[atIdx - 1])) {
        setMentionQuery(null);
        return;
      }
      // @ 后面不能有空格（否则已不在输入中）
      const query = before.slice(atIdx + 1);
      if (/\s/.test(query)) {
        setMentionQuery(null);
        return;
      }
      setMentionQuery(query);
      setMentionIndex(0);
    },
    [isGroupPanel],
  );

  const insertMention = useCallback(
    (role: GroupRoleView) => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursorPos = textarea.selectionStart;
      const before = draft.slice(0, cursorPos);
      const atIdx = before.lastIndexOf("@");
      if (atIdx === -1) return;
      const after = draft.slice(cursorPos);
      const newDraft = `${before.slice(0, atIdx)}${after}`;
      setDraft(newDraft);
      setSelectedMentionRoleIds((current) =>
        current.includes(role.id) ? current : [...current, role.id],
      );
      setMentionQuery(null);
      // 恢复光标位置
      requestAnimationFrame(() => {
        const newPos = atIdx;
        textarea.setSelectionRange(newPos, newPos);
        textarea.focus();
      });
    },
    [draft, setDraft, setSelectedMentionRoleIds],
  );

  const handleMentionKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (mentionCandidates.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, mentionCandidates.length - 1));
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[mentionIndex]);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return true;
      }
      return false;
    },
    [mentionCandidates, mentionIndex, insertMention],
  );

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!latestVoiceInputFile) {
      setVoicePreviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }
        return null;
      });
      return;
    }

    const nextUrl = URL.createObjectURL(latestVoiceInputFile);
    setVoicePreviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current);
      }
      return nextUrl;
    });

    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [latestVoiceInputFile]);

  const appendFiles = useCallback(
    (files: File[]) => {
      const validFiles = files.filter((f) => f.size <= 10 * 1024 * 1024);
      if (validFiles.length < files.length) {
        setErrorMessage("文件过大，单次单文件上传不能超过 10MB。超大文件已被过滤。");
      } else {
        setErrorMessage(null);
      }
      if (validFiles.length > 0) {
        setSelectedFiles((prev) => [...prev, ...validFiles]);
      }
    },
    [setErrorMessage, setSelectedFiles],
  );

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      appendFiles(files);
      if (files.length > 0 && isMobileInputMode) {
        setMobileComposerExpanded(true);
      }
      event.currentTarget.value = "";
    },
    [appendFiles, isMobileInputMode, setMobileComposerExpanded],
  );

  const openFilePicker = useCallback(() => {
    if (isMobileInputMode) {
      setMobileComposerExpanded(true);
    }
    fileInputRef.current?.click();
  }, [isMobileInputMode, setMobileComposerExpanded]);

  const handleVoiceRecord = useCallback(async () => {
    if (isRecordingVoice) {
      mediaRecorderRef.current?.stop();
      return;
    }

    if (typeof window === "undefined" || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setErrorMessage("当前浏览器不支持语音录制。");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      setErrorMessage("当前浏览器不支持语音录制。");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      mediaChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          mediaChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setErrorMessage("语音录制失败，请重试。");
        setIsRecordingVoice(false);
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.onstop = () => {
        const blob = new Blob(mediaChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        mediaChunksRef.current = [];
        setIsRecordingVoice(false);
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;

        if (blob.size === 0) {
          return;
        }

        const ext = blob.type.includes("ogg") ? "ogg" : "webm";
        const file = new File(
          [blob],
          `${VOICE_INPUT_FILENAME_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`,
          { type: blob.type || "audio/webm" },
        );
        appendFiles([file]);
      };

      recorder.start();
      setErrorMessage(null);
      setIsRecordingVoice(true);
      if (isMobileInputMode) {
        setMobileComposerExpanded(true);
      }
    } catch {
      setErrorMessage("无法访问麦克风，请检查浏览器权限。");
      setIsRecordingVoice(false);
    }
  }, [appendFiles, isMobileInputMode, isRecordingVoice, setErrorMessage, setMobileComposerExpanded]);

  return (
    <form
      ref={composerFormRef}
      onSubmit={onSend}
      autoComplete="off"
      data-lpignore="true"
      data-1p-ignore="true"
      data-bwignore="true"
      className={`shrink-0 border-t border-black/8 bg-[var(--paper)] md:px-5 md:py-4 ${
        composerCompactMobile ? "px-2 py-1.5" : "px-3 py-2"
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="pointer-events-none absolute -left-[9999px] h-px w-px opacity-0"
        accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.md,.zip,.rar,.7z,.tar,.gz,.tgz,.bz2,.xz,.tbz,.tbz2,.txz,.lz,.lzma,.zst,.tar.gz,.tar.bz2,.tar.xz"
        multiple
        title="上传文件"
        onChange={handleFileInputChange}
      />

      <div
        className={`rounded-[24px] border border-black/10 bg-white shadow-[0_12px_32px_rgba(15,23,36,0.06)] transition-all ${
          composerCompactMobile ? "px-3 py-2" : composerExpanded ? "p-3" : "p-2"
        }`}
      >
        {composerCompactMobile ? (
          <div className="flex items-end gap-2.5">
            <textarea
              ref={textareaRef}
              className="h-7 min-h-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-sm leading-6 outline-none"
              placeholder={isGroupPanel
                ? `输入消息，用 @ 指定角色...`
                : `和 ${displayAssistantRoleName} 对话。支持图片、音频、视频、文档一起上传。`}
              name="chat_message_input"
              autoComplete="off"
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              inputMode="text"
              rows={1}
              enterKeyHint={isMobileInputMode ? "enter" : "send"}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                checkMentionTrigger(e.target.value, e.target.selectionStart);
              }}
              onFocus={() => {
                setComposerFocused(true);
                if (isMobileInputMode) {
                  setMobileComposerExpanded(true);
                  requestAnimationFrame(() => {
                    messageListRef.current?.scrollTo({
                      top: messageListRef.current.scrollHeight,
                    });
                  });
                }
              }}
              onBlur={() => {
                setComposerFocused(false);
                if (isMobileInputMode && !hasComposerContent) {
                  setTimeout(() => setMobileComposerExpanded(false), 200);
                }
                // 延迟关闭，允许点击候选项
                setTimeout(() => setMentionQuery(null), 200);
              }}
              onKeyDown={(e) => {
                if (handleMentionKeyDown(e)) return;
                if (e.key === "Enter" && !isMobileInputMode && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  composerFormRef.current?.requestSubmit();
                }
              }}
            />
            <button
              type="button"
              onClick={openFilePicker}
              className="relative z-0 inline-flex h-9 shrink-0 cursor-pointer items-center rounded-full border border-black/10 bg-white px-3 text-xs font-medium text-[var(--ink)] transition hover:border-[var(--accent)] touch-manipulation"
            >
              上传
            </button>
            <button
              type="button"
              onClick={() => {
                if (isMobileInputMode) setMobileComposerExpanded(true);
                void handleVoiceRecord();
              }}
              aria-label={isRecordingVoice ? "停止语音输入" : "开始语音输入"}
              title={isRecordingVoice ? "停止语音输入" : "开始语音输入"}
              className={`relative z-10 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition touch-manipulation ${
                isRecordingVoice
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-black/10 bg-white text-[var(--ink)] hover:border-[var(--accent)]"
              }`}
            >
              {isRecordingVoice ? (
                <span className="h-3 w-3 rounded-sm bg-current" />
              ) : (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z" />
                  <path d="M6.5 10.5v1a5.5 5.5 0 0 0 11 0v-1" />
                  <path d="M12 17v3" />
                </svg>
              )}
            </button>
          </div>
        ) : (
          <>
            <div className="relative">
              <textarea
                ref={textareaRef}
                className={`w-full resize-none bg-transparent px-1 py-1 text-sm leading-6 outline-none transition-all ${
                  isMobileInputMode
                    ? "min-h-[4.5rem] max-h-36"
                    : composerExpanded
                    ? "min-h-24 max-h-56"
                    : "h-7 min-h-0 overflow-hidden"
                }`}
                placeholder={isGroupPanel
                  ? `输入消息，用 @ 指定角色...`
                  : `和 ${displayAssistantRoleName} 对话。支持图片、音频、视频、文档一起上传。`}
                name="chat_message_input"
                autoComplete="off"
                autoCapitalize="sentences"
                autoCorrect="on"
                spellCheck
                inputMode="text"
                rows={composerExpanded ? 3 : 1}
                enterKeyHint={isMobileInputMode ? "enter" : "send"}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  checkMentionTrigger(e.target.value, e.target.selectionStart);
                }}
                onFocus={() => {
                  setComposerFocused(true);
                  if (isMobileInputMode) {
                    setMobileComposerExpanded(true);
                    requestAnimationFrame(() => {
                      messageListRef.current?.scrollTo({
                        top: messageListRef.current.scrollHeight,
                      });
                    });
                  }
                }}
                onBlur={() => {
                  setComposerFocused(false);
                  if (isMobileInputMode && !hasComposerContent) {
                    setTimeout(() => setMobileComposerExpanded(false), 200);
                  }
                  setTimeout(() => setMentionQuery(null), 200);
                }}
                onKeyDown={(e) => {
                  if (handleMentionKeyDown(e)) return;
                  if (e.key === "Enter" && !isMobileInputMode && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    composerFormRef.current?.requestSubmit();
                  }
                }}
              />

              {/* @ 自动补全候选列表 */}
              {mentionCandidates.length > 0 ? (
                <div className="absolute bottom-full left-0 z-20 mb-1 w-full max-w-xs rounded-2xl border border-black/10 bg-white py-1 shadow-[0_8px_24px_rgba(0,0,0,0.12)]">
                  {mentionCandidates.map((role, i) => (
                    <button
                      key={role.id}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault(); // 阻止 blur
                        insertMention(role);
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ${
                        i === mentionIndex
                          ? "bg-[var(--paper-2)] text-[var(--ink)]"
                          : "text-[var(--ink)] hover:bg-[var(--paper-2)]"
                      }`}
                    >
                      <span className="flex h-6 w-6 items-center justify-center rounded-full border border-black/8 bg-white text-[10px] font-semibold text-[var(--ink-soft)]">
                        {role.emoji ?? agentMap.get(role.agentId)?.emoji ?? role.title.slice(0, 1)}
                      </span>
                      <span className="font-medium">{role.title}</span>
                      {role.isLeader && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700">
                          组长
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={openFilePicker}
                className="relative inline-flex h-9 cursor-pointer items-center rounded-full border border-black/10 bg-white px-3 text-xs font-medium text-[var(--ink)] transition hover:border-[var(--accent)] md:px-4 md:text-sm"
              >
                上传
              </button>

              <button
                type="button"
                onClick={() => void handleVoiceRecord()}
                aria-label={isRecordingVoice ? "停止语音输入" : "开始语音输入"}
                title={isRecordingVoice ? "停止语音输入" : "开始语音输入"}
                className={`relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border text-xs font-medium transition touch-manipulation md:h-12 md:w-12 ${
                  isRecordingVoice
                    ? "border-red-300 bg-red-50 text-red-700"
                    : "border-black/10 bg-white text-[var(--ink)] hover:border-[var(--accent)]"
                }`}
              >
                {isRecordingVoice ? (
                  <span className="h-3.5 w-3.5 rounded-sm bg-current" />
                ) : (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 4a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V7a3 3 0 0 1 3-3Z" />
                    <path d="M6.5 10.5v1a5.5 5.5 0 0 0 11 0v-1" />
                    <path d="M12 17v3" />
                  </svg>
                )}
              </button>

              {regularSelectedFiles.length > 0 && (
                <span className="rounded-full bg-[var(--paper-2)] px-3 py-1.5 text-[10px] text-[var(--ink-soft)] md:text-xs">
                  已选 {regularSelectedFiles.length} 个文件
                </span>
              )}

              {regularSelectedFiles.map((file) => (
                <span
                  key={`${file.name}-${file.lastModified}`}
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--paper-2)] px-3 py-1.5 text-[10px] text-[var(--ink-soft)] md:px-3 md:py-2 md:text-xs"
                >
                  <span className="max-w-[140px] truncate md:max-w-[220px]">
                    {file.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFiles((current) =>
                        current.filter((candidate) => candidate !== file),
                      );
                    }}
                    className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-black/10 text-[10px] leading-none transition hover:border-red-300 hover:text-red-700 md:h-5 md:w-5 md:text-[11px]"
                  >
                    ×
                  </button>
                </span>
              ))}

              {!hasVoiceInput ? (
                <button
                  type="submit"
                  className="ml-auto rounded-full bg-[var(--ink)] px-4 py-2 text-xs font-semibold text-[var(--paper)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 md:px-5 md:py-2.5 md:text-sm"
                  disabled={sendDisabled}
                >
                  {sendButtonLabel}
                </button>
              ) : null}
            </div>
          </>
        )}

        {isRecordingVoice ? (
          <div className="mt-3 flex items-center justify-between rounded-[20px] border border-red-200 bg-red-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
              <span className="text-sm font-medium text-red-700">正在语音输入...</span>
            </div>
            <button
              type="button"
              onClick={() => void handleVoiceRecord()}
              className="rounded-full border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
            >
              结束
            </button>
          </div>
        ) : null}

        {!isRecordingVoice && latestVoiceInputFile ? (
          <div className="mt-3 rounded-[20px] border border-black/10 bg-[var(--paper-2)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--ink)]">语音输入已就绪</div>
                <div className="mt-1 text-xs text-[var(--ink-soft)]">
                  {latestVoiceInputFile.type || "audio/webm"} · {(latestVoiceInputFile.size / 1024).toFixed(1)} KB
                </div>
              </div>
              {voicePreviewUrl ? (
                <audio controls className="max-w-[220px]" src={voicePreviewUrl} />
              ) : null}
            </div>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setSelectedFiles((current) => current.filter((file) => !isVoiceInputFile(file)));
                }}
                className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-semibold text-[var(--ink-soft)] transition hover:border-red-300 hover:text-red-700"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-full bg-[var(--ink)] px-4 py-1.5 text-xs font-semibold text-[var(--paper)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={sendDisabled}
              >
                {sendButtonLabel}
              </button>
            </div>
          </div>
        ) : null}

        {selectedMentionRoles.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {selectedMentionRoles.map(({ role, emoji }) => (
              <span
                key={role.id}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--paper-2)] px-3 py-1.5 text-[10px] text-[var(--ink-soft)] md:px-3 md:py-2 md:text-xs"
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-black/8 bg-white text-[9px] font-semibold text-[var(--ink-soft)] md:h-5 md:w-5 md:text-[10px]">
                  {emoji || role.title.slice(0, 1)}
                </span>
                <span className="max-w-[140px] truncate md:max-w-[220px]">
                  已@{role.title}{emoji ? ` ${emoji}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedMentionRoleIds((current) =>
                      current.filter((currentRoleId) => currentRoleId !== role.id),
                    );
                  }}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-black/10 text-[10px] leading-none transition hover:border-red-300 hover:text-red-700 md:h-5 md:w-5 md:text-[11px]"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {errorMessage && (
        <div className="mt-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </div>
      )}
    </form>
  );
}
