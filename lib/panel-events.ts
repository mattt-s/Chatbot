/**
 * @module panel-events
 * Dashboard 面板列表变更事件发布/订阅模块。
 *
 * 用于把“后台工具创建群组/修改群成员”这类非当前页面直接发起的变更，
 * 通过 dashboard 级 SSE 通知前端刷新侧边栏面板列表。
 */
import "server-only";

export type DashboardPanelEventReason =
  | "panel_created"
  | "panel_updated"
  | "panel_deleted"
  | "group_role_created"
  | "group_role_updated"
  | "group_role_deleted";

export type DashboardPanelEventPayload = {
  userId: string;
  panelId: string;
  reason: DashboardPanelEventReason;
  ts: number;
};

type Listener = (payload: DashboardPanelEventPayload) => void;

declare global {
  var __chatbotDashboardPanelListeners: Set<Listener> | undefined;
}

function listeners() {
  if (!globalThis.__chatbotDashboardPanelListeners) {
    globalThis.__chatbotDashboardPanelListeners = new Set();
  }

  return globalThis.__chatbotDashboardPanelListeners;
}

/**
 * 广播一个 dashboard 面板列表变更事件。
 */
export function publishDashboardPanelEvent(
  payload: Omit<DashboardPanelEventPayload, "ts"> & { ts?: number },
) {
  const eventPayload: DashboardPanelEventPayload = {
    ...payload,
    ts: payload.ts ?? Date.now(),
  };

  for (const listener of listeners()) {
    try {
      listener(eventPayload);
    } catch {
      // Ignore listener failures so one SSE client does not break others.
    }
  }
}

/**
 * 订阅某个用户的 dashboard 面板列表变更事件。
 */
export function subscribeDashboardPanelEvent(
  userId: string,
  listener: (payload: DashboardPanelEventPayload) => void,
) {
  const wrappedListener: Listener = (payload) => {
    if (payload.userId !== userId) {
      return;
    }
    listener(payload);
  };

  listeners().add(wrappedListener);
  return () => {
    listeners().delete(wrappedListener);
  };
}
