import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("panel-events", () => {
  beforeEach(() => {
    vi.resetModules();
    delete globalThis.__chatbotDashboardPanelListeners;
  });

  it("只向同一用户的订阅者推送 panel 事件", async () => {
    const {
      publishDashboardPanelEvent,
      subscribeDashboardPanelEvent,
    } = await import("@/lib/panel-events");

    const user1Events: unknown[] = [];
    const user2Events: unknown[] = [];

    const unsubscribeUser1 = subscribeDashboardPanelEvent("u1", (payload) => {
      user1Events.push(payload);
    });
    subscribeDashboardPanelEvent("u2", (payload) => {
      user2Events.push(payload);
    });

    publishDashboardPanelEvent({
      userId: "u1",
      panelId: "panel-1",
      reason: "panel_created",
      ts: 123,
    });
    unsubscribeUser1();
    publishDashboardPanelEvent({
      userId: "u1",
      panelId: "panel-2",
      reason: "panel_deleted",
      ts: 456,
    });

    expect(user1Events).toEqual([
      {
        userId: "u1",
        panelId: "panel-1",
        reason: "panel_created",
        ts: 123,
      },
    ]);
    expect(user2Events).toEqual([]);
  });
});
