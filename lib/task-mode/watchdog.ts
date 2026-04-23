/**
 * @module task-mode/watchdog
 * 任务模式专属 watchdog 定时器。
 * 每 60 秒双轨扫描：
 *   - assigned 超时 5 分钟：重新 dispatch 或置为 needs_intervention
 *   - in_progress 超时 10 分钟：abort/提醒后重试，或置为 needs_intervention
 * 独立于聊天模式的 watchdog，不共享任何状态。
 */
import "server-only";

import { readGroupTasks } from "@/lib/store";
import { createLogger } from "@/lib/logger";
import { watchdogRedispatch, watchdogCheckInProgress } from "@/lib/task-mode/app-rpc-handlers";

const log = createLogger("task-mode:watchdog");

const ASSIGNED_TIMEOUT_MS = 5 * 60 * 1000;    // assigned 超时：5 分钟
const IN_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000; // in_progress 超时：10 分钟
const SCAN_INTERVAL_MS = 60 * 1000;             // 每 60 秒扫描一次

let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动任务模式 watchdog 定时器（幂等，重复调用无副作用）。
 * 在 lib/task-mode/init.ts 的启动流程中调用，或在模块首次加载时调用。
 */
export function startTaskModeWatchdog() {
  if (watchdogTimer !== null) return;

  watchdogTimer = setInterval(() => {
    void Promise.all([
      scanAndRetry().catch((err) => log.error("watchdog.scanAssigned", err)),
      scanInProgress().catch((err) => log.error("watchdog.scanInProgress", err)),
    ]);
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
        now - new Date(t.lastDispatchAt).getTime() > ASSIGNED_TIMEOUT_MS,
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

/**
 * 扫描所有 status=in_progress 且 lastDispatchAt 超过 10 分钟的任务。
 * 区分"run 仍在跑"和"run 已结束但未提交"两种场景分别处理。
 */
async function scanInProgress() {
  const { readAllGroupTasks } = await import("@/lib/store");
  const allTasks = await readAllGroupTasks();
  const now = Date.now();

  const stalePanelIds = new Set(
    allTasks
      .filter(
        (t) =>
          t.status === "in_progress" &&
          t.lastDispatchAt &&
          now - new Date(t.lastDispatchAt).getTime() > IN_PROGRESS_TIMEOUT_MS,
      )
      .map((t) => t.panelId),
  );

  for (const panelId of stalePanelIds) {
    const tasks = await readGroupTasks(panelId);

    const stale = tasks.filter(
      (t) =>
        t.status === "in_progress" &&
        t.lastDispatchAt &&
        now - new Date(t.lastDispatchAt).getTime() > IN_PROGRESS_TIMEOUT_MS,
    );

    for (const task of stale) {
      log.debug("watchdog.staleInProgress", {
        panelId,
        taskId: task.id,
        lastDispatchAt: task.lastDispatchAt ?? "none",
        activeRunId: task.activeRunId ?? "none",
      });

      void watchdogCheckInProgress(panelId, task.id).catch((err) => {
        log.error("watchdog.checkInProgress", err, { panelId, taskId: task.id });
      });
    }
  }
}
