/**
 * Transient confirmations — "복사되었습니다" and friends.
 *
 * These exist because an action like copying leaves no visible trace: without
 * a acknowledgement the user cannot tell a successful copy from a no-op.
 */

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}

const DEFAULT_MS = 1600;

let nextId = 0;

class Toasts {
  items = $state<Toast[]>([]);

  show(message: string, tone: Toast["tone"] = "info", ms = DEFAULT_MS) {
    const id = ++nextId;
    this.items = [...this.items, { id, message, tone }];
    setTimeout(() => this.dismiss(id), ms);
  }

  dismiss(id: number) {
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new Toasts();
