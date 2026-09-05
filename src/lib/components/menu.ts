/** Shared shape for ContextMenu entries, so plain modules can build them too. */
export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
  /**
   * Marks one entry as the one already in effect — the open tab, in the only
   * menu that needs it. Set it on an item and the whole menu gains a column
   * for the mark, so entries stay aligned whether or not each is checked; a
   * menu where nobody sets it is drawn exactly as it was before.
   */
  checked?: boolean;
  /**
   * Identity for redraws, when two entries can legitimately read the same.
   *
   * The label is the key otherwise, which is right for a fixed menu of
   * commands. A menu built from documents is not fixed: two pasted documents
   * carry the same name and have no path to tell them apart, and keying those
   * by label would collapse them into one and throw.
   */
  key?: string;
}
