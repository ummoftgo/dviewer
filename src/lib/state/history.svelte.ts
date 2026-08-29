/**
 * Where the reader has been inside one document.
 *
 * Following a container in the key/value table is a jump, and a jump you
 * cannot undo is a trap: three levels down a deep document there is no way
 * back to where you were reading. So every node the reader lands on is
 * recorded, and the side buttons on the mouse walk the list.
 *
 * The semantics are a browser's, because that is what the side buttons mean
 * everywhere else: going somewhere new abandons whatever was ahead.
 */
export class NodeHistory {
  /** Visited nodes, oldest first. */
  private entries = $state<number[]>([]);
  /** Index of the node being shown; -1 before the first visit. */
  private at = $state(-1);

  /**
   * A long session in a wide document would otherwise keep every step of it,
   * and the oldest entries are the ones nobody walks back to.
   */
  private static readonly LIMIT = 200;

  get current(): number | null {
    return this.at < 0 ? null : this.entries[this.at];
  }

  get canBack(): boolean {
    return this.at > 0;
  }

  get canForward(): boolean {
    return this.at >= 0 && this.at < this.entries.length - 1;
  }

  /**
   * Record a node the reader moved to.
   *
   * Arriving where you already are is not a step, and that is what keeps the
   * callers simple: `back()` moves the cursor and then the selection follows,
   * and the selection change arrives back here as a no-op instead of pushing
   * the node it was just asked to leave.
   */
  visit(node: number) {
    if (node === this.current) return;
    this.entries = [...this.entries.slice(0, this.at + 1), node];
    if (this.entries.length > NodeHistory.LIMIT) {
      this.entries = this.entries.slice(this.entries.length - NodeHistory.LIMIT);
    }
    this.at = this.entries.length - 1;
  }

  /** The previous node, or null if there is none. */
  back(): number | null {
    if (!this.canBack) return null;
    this.at -= 1;
    return this.entries[this.at];
  }

  /** The node stepped back from, or null if nothing was. */
  forward(): number | null {
    if (!this.canForward) return null;
    this.at += 1;
    return this.entries[this.at];
  }

  reset() {
    this.entries = [];
    this.at = -1;
  }
}
