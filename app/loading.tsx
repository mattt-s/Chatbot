/**
 * @file 全局加载骨架屏
 * @description 页面加载过程中显示的骨架屏 UI，包含侧边栏、聊天区域和输入框的占位动画
 */

/**
 * 全局加载状态组件
 * @description 使用 CSS 动画展示侧边栏和聊天区域的骨架占位符。
 * @returns 骨架屏 UI
 */
export default function Loading() {
  return (
    <main className="h-[100dvh] w-full overflow-hidden bg-[var(--canvas)] md:p-4">
      <div className="flex h-full w-full gap-0 md:mx-auto md:max-w-[1680px] md:gap-4">
        {/* Sidebar skeleton */}
        <aside className="hidden w-[320px] shrink-0 animate-pulse flex-col rounded-[30px] border border-black/10 bg-[var(--paper)] p-3 lg:flex">
          <div className="px-2 py-1">
            <div className="h-3 w-12 rounded bg-black/8" />
            <div className="mt-2 h-6 w-24 rounded bg-black/8" />
          </div>
          <div className="mt-3 h-11 rounded-[22px] bg-black/8" />
          <div className="mt-4 flex-1 space-y-2">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="rounded-[24px] border border-black/8 bg-white p-3"
              >
                <div className="flex gap-3">
                  <div className="h-11 w-11 shrink-0 rounded-2xl bg-black/8" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-24 rounded bg-black/8" />
                    <div className="h-3 w-16 rounded bg-black/6" />
                    <div className="h-3 w-full rounded bg-black/5" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Chat area skeleton */}
        <section className="flex min-w-0 flex-1 animate-pulse flex-col overflow-hidden bg-[var(--paper)] md:rounded-[32px] md:border md:border-black/10">
          {/* Header */}
          <div className="shrink-0 border-b border-black/8 px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-16 rounded-full bg-black/8 lg:hidden" />
              <div className="h-9 flex-1 rounded-full bg-black/6" />
              <div className="h-6 w-20 rounded-full bg-black/8" />
              <div className="h-6 w-24 rounded-full bg-black/6" />
            </div>
          </div>

          {/* Message area */}
          <div className="flex-1 space-y-4 bg-[#e5ebe3] px-6 py-5">
            <div className="mx-auto max-w-lg rounded-[28px] border border-dashed border-black/8 bg-white/70 px-5 py-12">
              <div className="mx-auto h-5 w-40 rounded bg-black/8" />
              <div className="mx-auto mt-3 h-4 w-56 rounded bg-black/6" />
            </div>
          </div>

          {/* Composer */}
          <div className="shrink-0 border-t border-black/8 px-5 py-4">
            <div className="rounded-[24px] border border-black/10 bg-white p-3">
              <div className="h-7 w-full rounded bg-black/5" />
              <div className="mt-3 flex items-center gap-2">
                <div className="h-9 w-16 rounded-full bg-black/8" />
                <div className="ml-auto h-9 w-16 rounded-full bg-black/8" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
