/**
 * @module task-mode/sse
 * 任务模式专属 SSE 发布/订阅模块。
 * 任何任务状态变更后调用 publishGroupTasksUpdate(panelId)，
 * 已订阅该 panelId 的前端连接会立即收到通知并刷新看板。
 */
import "server-only";

import { createLogger } from "@/lib/logger";

const log = createLogger("task-mode:sse");

type TasksUpdateListener = (panelId: string) => void;

declare global {
  var __taskModeUpdateListeners: Set<TasksUpdateListener> | undefined;
}

function listeners(): Set<TasksUpdateListener> {
  if (!globalThis.__taskModeUpdateListeners) {
    globalThis.__taskModeUpdateListeners = new Set();
  }
  return globalThis.__taskModeUpdateListeners;
}

/**
 * 通知所有订阅了该 panelId 的前端连接：任务列表已变更，请重新拉取。
 */
export function publishGroupTasksUpdate(panelId: string) {
  const all = listeners();
  log.debug("publishGroupTasksUpdate", {
    panelId,
    listenerCount: String(all.size),
  });
  for (const listener of all) {
    try {
      listener(panelId);
    } catch {
      // 单个 listener 异常不影响其他连接
    }
  }
}

/**
 * 注册任务更新监听器，返回取消订阅函数。
 */
export function subscribeGroupTasksUpdate(listener: TasksUpdateListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}
