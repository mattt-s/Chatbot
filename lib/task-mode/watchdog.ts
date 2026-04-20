/**
 * @module task-mode/watchdog
 * 任务模式专属 watchdog 定时器。
 * 每 60 秒扫描一次所有 status=assigned 且 lastDispatchAt 超过 5 分钟的任务，
 * 触发 watchdog 重试或置为 needs_intervention。
 * 独立于聊天模式的 watchdog，不共享任何状态。
 */
import "server-only";

import { readGroupTasks } from "@/lib/store";
import { createLogger } from "@/lib/logger";
import { watchdogRedispatch } from "@/lib/task-mode/app-rpc-handlers";

const log = createLogger("task-mode:watchdog");

const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟
const SCAN_INTERVAL_MS = 60 * 1000;         // 每 60 秒扫描一次

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动任务模式 watchdog 定时器（幂等，重复调用无副作用）。
 * 在 lib/task-mode/init.ts 的启动流程中调用，或在模块首次加载时调用。
 */
export function startTaskModeWatchdog() {
  if (watchdogTimer !== null) return;

  watchdogTimer = setInterval(() => {
    void scanAndRetry().catch((err) => {
      log.error("watchdog.scan", err);
    });
  }, SCAN_INTERVAL_MS);

  log.debug("startTaskModeWatchdog", { intervalMs: String(SCAN_INTERVAL_MS) });
}

export function stopTaskModeWatchdog() {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

async function scanAndRetry() {
  const { readAllGroupTasks } = await import("@/lib/store");
  const allTasks = await readAllGroupTasks();
  const taskPanelIds = new Set(
    allTasks
      .filter((t) => t.status === "assigned" && t.lastDispatchAt)
      .map((t) => t.panelId),
  );

  for (const panelId of taskPanelIds) {
    const tasks = await readGroupTasks(panelId);
    const now = Date.now();

    const stale = tasks.filter(
      (t) =>
        t.status === "assigned" &&
        t.lastDispatchAt &&
        now - new Date(t.lastDispatchAt).getTime() > DISPATCH_TIMEOUT_MS,
    );

    for (const task of stale) {
      log.debug("watchdog.staleTask", {
        panelId,
        taskId: task.id,
        lastDispatchAt: task.lastDispatchAt ?? "none",
      });

      void watchdogRedispatch(panelId, task.id).catch((err) => {
        log.error("watchdog.redispatch", err, { panelId, taskId: task.id });
      });
    }
  }
}
