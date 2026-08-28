/** Shared shape for ContextMenu entries, so plain modules can build them too. */
export interface MenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Right-aligned hint, e.g. a keyboard shortcut. */
  hint?: string;
}
