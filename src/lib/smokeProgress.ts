/** Smoke-only observations; they never satisfy a test or advance its waits. */
import { frameTrace } from './ipc';

let phase = 'initialize';
let frames = 0;
let frameId = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let watching = false;

function record(event: 'phase' | 'timer', timerMs = 0): void {
  // No document paths, URLs, text, DOM snapshots or settings enter this record.
  void frameTrace(0, JSON.stringify({ origin: 'smoke-progress', event, phase,
    visibility: document.visibilityState, readyState: document.readyState,
    focused: document.hasFocus(), frames, timerMs })).catch(() => {});
}

export function traceSmokeProgress(next: string): void {
  phase = next;
  record('phase');
}

export function stopSmokeProgress(): void {
  watching = false;
  cancelAnimationFrame(frameId);
  for (const timer of timers) clearTimeout(timer);
  timers = [];
}

export function watchSmokeProgress(): void {
  stopSmokeProgress();
  watching = true;
  frames = 0;
  const frame = () => {
    if (!watching) return;
    frames++;
    frameId = requestAnimationFrame(frame);
  };
  frameId = requestAnimationFrame(frame);
  // Observe timer delivery independently from rendering, for at most 45 seconds.
  timers = [2_000, 10_000, 30_000, 45_000].map(ms => setTimeout(() => {
    record('timer', ms);
    if (ms === 45_000) stopSmokeProgress();
  }, ms));
}
