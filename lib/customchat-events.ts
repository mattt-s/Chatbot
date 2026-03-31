/**
 * @module customchat-events
 * CustomChat 事件发布/订阅模块。
 * 通过全局单例维护 SSE 监听器集合，实现 CustomChat 消息事件的广播与订阅。
 */
import "server-only";

import { createLogger } from "@/lib/logger";
import type { ChatEventPayload } from "@/lib/types";

const log = createLogger("events");

type Listener = (payload: ChatEventPayload) => void;

declare global {
  var __chatbotCustomChatListeners: Set<Listener> | undefined;
}

function listeners() {
  if (!globalThis.__chatbotCustomChatListeners) {
    globalThis.__chatbotCustomChatListeners = new Set();
  }

  return globalThis.__chatbotCustomChatListeners;
}

/**
 * 向所有已注册的 SSE 监听器广播一个聊天事件。
 * 单个监听器抛出异常不会影响其他监听器的接收。
 * @param {ChatEventPayload} payload - 聊天事件载荷，包含 runId、state、消息内容等
 */
export function publishCustomChatEvent(payload: ChatEventPayload) {
  const listenerCount = listeners().size;
  log.debug("publishCustomChatEvent", {
    runId: payload.runId,
    state: payload.state,
    sessionKey: payload.sessionKey,
    seq: String(payload.seq),
    listenerCount: String(listenerCount),
  });
  for (const listener of listeners()) {
    try {
      listener(payload);
    } catch {
      // Ignore listener failures so one SSE client does not break others.
    }
  }
}

/**
 * 注册一个聊天事件监听器。
 * @param {Listener} listener - 事件回调函数，收到 ChatEventPayload 时被调用
 * @returns {() => void} 取消订阅函数，调用后移除该监听器
 * @example
 * const unsubscribe = subscribeCustomChatEvent((payload) => {
 *   console.log("收到事件:", payload.runId);
 * });
 * // 不再需要时取消订阅
 * unsubscribe();
 */
export function subscribeCustomChatEvent(listener: Listener) {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}
