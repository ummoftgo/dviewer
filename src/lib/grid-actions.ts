/** Async grid actions must not apply a response after their view is gone. */
export class GridActions {
  private destroyed = false;

  constructor(private isCurrent: () => boolean, private cancel: () => void) {}

  current = (): boolean => !this.destroyed && this.isCurrent();

  /** Keep the last validity check and the side effect in the same continuation. */
  async run<T, R>(read: () => Promise<T>, apply: (value: T) => R | Promise<R>, unchanged = () => true): Promise<R> {
    const check = () => { if (!this.current() || !unchanged()) throw { code: 'cancelled' }; };
    check();
    const value = await read();
    check();
    return apply(value);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    // Cancellation must still run after current() becomes false.
    this.cancel();
  }
}
