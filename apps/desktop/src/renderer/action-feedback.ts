/** 先给已更新的操作状态一次绘制机会，再启动 IPC；后台窗口也不能无限等待。 */
export function paintActionFeedback(): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    let frame: number | undefined;
    let afterFrame: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      clearTimeout(afterFrame);
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      resolve();
    };
    const fallback = setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function') {
      frame = requestAnimationFrame(() => { frame = undefined; afterFrame = setTimeout(finish, 0); });
    } else afterFrame = setTimeout(finish, 0);
  });
}
