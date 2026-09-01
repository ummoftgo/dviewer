/**
 * Walking back through a document.
 *
 * The semantics are a browser's, because that is what the mouse's side buttons
 * mean everywhere else. The subtle one is `visit` being a no-op when it names
 * the node already shown — `back()` moves the cursor and the selection follows,
 * and that selection change arrives back here. Without the guard, stepping back
 * would push the node it was just asked to leave, and forward would be dead.
 */
import { describe, expect, test } from "vitest";
import { NodeHistory } from "./history.svelte";

describe("an empty history", () => {
  test("goes nowhere and says so", () => {
    const history = new NodeHistory();
    expect(history.current).toBeNull();
    expect(history.canBack).toBe(false);
    expect(history.canForward).toBe(false);
    expect(history.back()).toBeNull();
    expect(history.forward()).toBeNull();
  });

  test("one visit is somewhere, but not somewhere to come back from", () => {
    const history = new NodeHistory();
    history.visit(7);
    expect(history.current).toBe(7);
    expect(history.canBack).toBe(false);
  });
});

describe("walking", () => {
  function walked(...nodes: number[]) {
    const history = new NodeHistory();
    for (const node of nodes) history.visit(node);
    return history;
  }

  test("back and forward retrace the same steps", () => {
    const history = walked(1, 2, 3);
    expect(history.back()).toBe(2);
    expect(history.back()).toBe(1);
    expect(history.canBack).toBe(false);
    expect(history.forward()).toBe(2);
    expect(history.forward()).toBe(3);
    expect(history.canForward).toBe(false);
  });

  /** The browser rule: going somewhere new abandons whatever was ahead. */
  test("a new step abandons what was ahead", () => {
    const history = walked(1, 2, 3);
    history.back();
    history.visit(9);
    expect(history.canForward).toBe(false);
    expect(history.current).toBe(9);
    // Back from 9 is 2, the node it was opened from — not 1. What was ahead of
    // 2 is gone; what was behind it is not.
    expect(history.back()).toBe(2);
    expect(history.back()).toBe(1);
  });

  /**
   * The guard that makes the callers simple. `back()` returns 2, the view
   * selects node 2, and the selection change calls `visit(2)` — which must do
   * nothing, or the forward step is gone.
   */
  test("arriving where you already are is not a step", () => {
    const history = walked(1, 2, 3);
    expect(history.back()).toBe(2);
    history.visit(2);
    expect(history.canForward).toBe(true);
    expect(history.forward()).toBe(3);
  });

  test("visiting the same node twice in a row records it once", () => {
    const history = walked(1, 1, 1);
    expect(history.canBack).toBe(false);
    expect(history.current).toBe(1);
  });

  /** Revisiting a node that is in the list, but is not where you are, is a step. */
  test("returning to an earlier node the long way is still a step", () => {
    const history = walked(1, 2, 1);
    expect(history.current).toBe(1);
    expect(history.back()).toBe(2);
  });
});

describe("a long session", () => {
  /** A wide document would otherwise keep every step, and the oldest entries
   *  are the ones nobody walks back to. */
  test("the list stops growing and drops the oldest", () => {
    const history = new NodeHistory();
    for (let node = 0; node < 250; node += 1) history.visit(node);
    expect(history.current).toBe(249);

    let steps = 0;
    while (history.canBack) {
      history.back();
      steps += 1;
    }
    expect(steps).toBe(199);
    expect(history.current).toBe(50);
  });
});

describe("reset", () => {
  test("leaves nothing to walk", () => {
    const history = new NodeHistory();
    history.visit(1);
    history.visit(2);
    history.reset();
    expect(history.current).toBeNull();
    expect(history.canBack).toBe(false);
    expect(history.canForward).toBe(false);
  });
});
