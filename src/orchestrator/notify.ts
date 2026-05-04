/**
 * NotifyScheduler — throttled + immediate change-notification.
 *
 * Rules:
 *   - `schedule()` — coalesce into the next ~300ms window. Used for
 *     high-frequency streaming/background events.
 *   - `flush()` — fire all listeners immediately and cancel any pending
 *     scheduled notification. Used for user-facing events where the
 *     user is actively waiting (ask_user, goal switch, errors, agent
 *     completion, orchestration-done).
 *
 * Separated from the manager so that the throttle policy is testable
 * in isolation and swappable (e.g. for a deterministic test clock).
 */

export type Listener = () => void;

export interface NotifyOptions {
  /** Throttle window in milliseconds. Default: 300. */
  throttleMs?: number;
}

export class NotifyScheduler {
  private listeners: Set<Listener> = new Set();
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly throttleMs: number;

  constructor(opts: NotifyOptions = {}) {
    this.throttleMs = opts.throttleMs ?? 300;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Throttled — coalesces bursts into at most one fire per window. */
  schedule(): void {
    if (this.pending) return;
    this.pending = true;
    this.timer = setTimeout(() => {
      this.pending = false;
      this.timer = null;
      this.fire();
    }, this.throttleMs);
  }

  /** Immediate — cancels any pending schedule and fires now. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.pending = false;
    }
    this.fire();
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.pending = false;
    }
    this.listeners.clear();
  }

  private fire(): void {
    // Snapshot the listener set to tolerate subscribe/unsubscribe during dispatch.
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch {
        // Listener errors must not break the scheduler. The TUI will
        // re-render on the next notification either way.
      }
    }
  }
}
