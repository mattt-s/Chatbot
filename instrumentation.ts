/**
 * Next.js Instrumentation Hook
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * 在 Node.js 运行时启动时执行一次，用于初始化任务模式的后台服务：
 * 1. 重建 pending dispatch 内存队列（根据持久化任务列表）
 * 2. 清空所有任务的 activeRunId（进程重启后 run 已丢失）
 * 3. 启动 watchdog 定时器
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  try {
    const { readAllGroupTasks } = await import("@/lib/store");
    const { rebuildPendingDispatchQueues, clearAllActiveRunIds } = await import(
      "@/lib/task-mode/store"
    );
    const { startTaskModeWatchdog } = await import("@/lib/task-mode/watchdog");

    // 1. 拉取所有任务，重建内存队列
    const allTasks = await readAllGroupTasks();
    rebuildPendingDispatchQueues(allTasks);

    // 2. 清空 activeRunId（进程重启后 gateway run 已不存在）
    const panelIds = [...new Set(allTasks.map((t) => t.panelId))];
    await Promise.all(panelIds.map((id) => clearAllActiveRunIds(id)));

    // 3. 启动 watchdog 定时器
    startTaskModeWatchdog();
  } catch (err) {
    // 初始化失败不阻塞应用启动，仅记录到控制台
    console.error("[instrumentation] task-mode init failed:", err);
  }
}
