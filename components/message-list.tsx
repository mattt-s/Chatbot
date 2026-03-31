/**
 * @file 消息列表组件。
 *
 * 渲染面板内的完整消息对话流，包括空状态提示和"滚动到底部"按钮。
 * 会自动过滤掉桥接投递的空壳消息，并对连续同角色消息进行分组标记。
 */
"use client";

import { useMemo, RefObject } from "react";
import type { AgentView, GroupRoleView, MessageView, SessionStatusView } from "@/lib/types";
import { MessageBubble } from "./message-bubble";
import {
  isBridgeDeliveryMessage,
  shouldHideBridgeDeliveryNoiseText,
} from "./chat-helpers";

/**
 * 对话列表中的单个条目，包含消息数据和分组信息。
 */
export interface ConversationItem {
  id: string;
  ts: number;
  type: "message";
  message: MessageView;
  isGroupStart: boolean;
  isGroupEnd: boolean;
}

/**
 * MessageList 的 Props。
 */
interface MessageListProps {
  messages: MessageView[];
  title: string;
  currentAgent: AgentView | null;
  agents?: AgentView[];
  displayUserRoleName: string;
  messageListRef: RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  onScrollToBottom: () => void;
  onPreview: (url: string) => void;
  onCollapse?: () => void;
  /** 是否为群组面板 */
  isGroupPanel?: boolean;
  /** 群组角色列表 */
  groupRoles?: GroupRoleView[];
  directSessionStatus?: SessionStatusView | null;
  groupRoleSessionStatuses?: Record<string, SessionStatusView | null>;
}

/**
 * 消息列表。
 *
 * 将消息数组转换为分组后的对话条目列表并逐条渲染 MessageBubble。
 * 过滤桥接投递空壳消息，计算连续同角色消息的分组边界。
 * 底部提供可选的"滚动到底部"浮动按钮。
 *
 * @param props.messages - 原始消息列表
 * @param props.title - 面板标题（用于助手角色显示名）
 * @param props.currentAgent - 当前 Agent 信息
 * @param props.displayUserRoleName - 用户角色显示名
 * @param props.messageListRef - 滚动容器的 ref
 * @param props.showScrollButton - 是否显示滚动到底部按钮
 * @param props.onScrollToBottom - 滚动到底部回调
 * @param props.onPreview - 图片预览回调
 * @param props.onCollapse - 点击列表区域时的折叠回调（移动端收起输入框）
 */
export function MessageList({
  messages,
  title,
  currentAgent,
  agents = [],
  displayUserRoleName,
  messageListRef,
  showScrollButton,
  onScrollToBottom,
  onPreview,
  onCollapse,
  isGroupPanel,
  groupRoles,
  directSessionStatus,
  groupRoleSessionStatuses,
}: MessageListProps) {
  const agentMap = useMemo(() => {
    const map = new Map<string, AgentView>();
    agents.forEach((agent) => {
      map.set(agent.id, agent);
    });
    return map;
  }, [agents]);

  // 构建群组角色 id→index/info 的映射
  const roleMap = useMemo(() => {
    const map = new Map<
      string,
      { index: number; role: GroupRoleView; agent: AgentView | null }
    >();
    if (groupRoles) {
      groupRoles.forEach((role, i) => {
        map.set(role.id, {
          index: i + 1,
          role,
          agent: agentMap.get(role.agentId) ?? null,
        });
      });
    }
    return map;
  }, [agentMap, groupRoles]);

  const conversationItems = useMemo<ConversationItem[]>(() => {
    const list = messages.filter((message) => !isBridgeDeliveryMessage(message));
    return list.map((message, index) => {
      const prev = list[index - 1];
      const next = list[index + 1];
      // 群组面板：不同角色的助手消息也算不同分组
      const sameGroup = (a: MessageView, b: MessageView) => {
        if (a.role !== b.role) return false;
        if (isGroupPanel && a.role === "assistant") {
          return (a.groupRoleId ?? "") === (b.groupRoleId ?? "");
        }
        return true;
      };
      const isGroupStart = !prev || !sameGroup(prev, message);
      const isGroupEnd = !next || !sameGroup(next, message);

      return {
        id: `msg:${message.id}`,
        ts: new Date(message.createdAt).getTime(),
        type: "message" as const,
        message,
        isGroupStart,
        isGroupEnd,
      };
    });
  }, [messages, isGroupPanel]);

  const displayAssistantRoleName = `${title.trim() || "助手"}${
    currentAgent?.emoji ? ` ${currentAgent.emoji}` : ""
  }`;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={messageListRef}
        onClick={onCollapse}
        className="touch-scroll h-full space-y-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-[#e5ebe3] px-4 py-5 md:px-6"
      >
        {conversationItems.length === 0 ? (
          <div className="rounded-[28px] border border-dashed border-black/10 bg-white/70 px-5 py-12 text-center text-sm text-[var(--ink-soft)]">
            {isGroupPanel
              ? "群组尚无消息。发送消息并 @角色 开始群组对话。"
              : "这个角色还没有消息。发一条消息开始对话。"}
          </div>
        ) : (
          conversationItems.map((item) => {
            const msg = item.message;
            const messageIndex = messages.findIndex((candidate) => candidate.id === msg.id);
            const roleInfo = msg.groupRoleId ? roleMap.get(msg.groupRoleId) : undefined;
            // 解析被 @mention 的角色名
            const mentionedRoles = isGroupPanel && msg.mentionedGroupRoleIds?.length
              ? msg.mentionedGroupRoleIds
                  .map((rid) => {
                    const info = roleMap.get(rid);
                    if (!info) return null;
                    return {
                      label: info.role.title,
                      emoji: info.role.emoji ?? info.agent?.emoji ?? null,
                    };
                  })
                  .filter((item): item is { label: string; emoji: string | null } => Boolean(item))
              : undefined;

            return (
              <MessageBubble
                key={item.id}
                message={msg}
                hideNoiseText={shouldHideBridgeDeliveryNoiseText(msg, messages, messageIndex)}
                userRoleName={displayUserRoleName}
                assistantRoleName={displayAssistantRoleName}
                agentAvatarUrl={currentAgent?.avatarUrl}
                runtimeSteps={msg.runtimeSteps}
                isGroupStart={item.isGroupStart}
                isGroupEnd={item.isGroupEnd}
                onPreview={onPreview}
                isGroupPanel={isGroupPanel}
                groupRoleLabel={roleInfo?.role.title}
                groupRoleEmoji={roleInfo?.role.emoji}
                groupRoleAgentEmoji={roleInfo?.agent?.emoji}
                groupRoleAvatarUrl={roleInfo?.agent?.avatarUrl}
                groupRoleIndex={roleInfo?.index}
                mentionedRoles={mentionedRoles}
                sessionStatus={
                  isGroupPanel
                    ? (msg.role === "assistant" && msg.groupRoleId
                        ? groupRoleSessionStatuses?.[msg.groupRoleId] ?? null
                        : null)
                    : (directSessionStatus ?? null)
                }
              />
            );
          })
        )}
      </div>

      {showScrollButton ? (
        <button
          type="button"
          onClick={onScrollToBottom}
          aria-label="滚动到底部"
          className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/90 text-[var(--ink-soft)] shadow-[0_4px_14px_rgba(0,0,0,0.12)] backdrop-blur-sm transition-all duration-200 hover:bg-white hover:text-[var(--ink)] hover:shadow-[0_6px_20px_rgba(0,0,0,0.16)] active:scale-90"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M10 3.5V16.5M10 16.5L4.5 11M10 16.5L15.5 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}
