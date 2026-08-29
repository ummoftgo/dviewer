<script lang="ts">
  /**
   * A handful of inline icons. Small enough that pulling in an icon package
   * would cost more than it saves, and inline SVG inherits currentColor so the
   * theme switch needs no extra work.
   */
  type IconName =
    | "file"
    | "link"
    | "clipboard"
    | "close"
    | "plus"
    | "settings"
    | "search"
    | "chevron-right"
    | "chevron-down"
    | "chevron-up"
    | "expand"
    | "collapse"
    | "sun"
    | "moon"
    | "auto"
    | "copy"
    | "list"
    | "filter"
    | "warning"
    | "external"
    | "chevron-left";

  const PATHS: Record<IconName, string> = {
    file: "M4 2.5h5.5L13 6v7.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z M9.5 2.5V6H13",
    link: "M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8 M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8",
    clipboard:
      "M6 3.5H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-1 M6 3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1H6v-1Z",
    close: "M4 4l8 8 M12 4l-8 8",
    external: "M9 2.5h4.5V7 M13.5 2.5 8 8 M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3",
    "chevron-left": "M10 3.5 5.5 8 10 12.5",
    plus: "M8 3.5v9 M3.5 8h9",
    settings:
      "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z M13 8a5 5 0 0 0-.1-1l1.2-.9-1.3-2.2-1.4.6a5 5 0 0 0-1.7-1L9.5 2h-3l-.2 1.5a5 5 0 0 0-1.7 1l-1.4-.6-1.3 2.2 1.2.9a5 5 0 0 0 0 2l-1.2.9 1.3 2.2 1.4-.6a5 5 0 0 0 1.7 1L6.5 14h3l.2-1.5a5 5 0 0 0 1.7-1l1.4.6 1.3-2.2-1.2-.9c.06-.33.1-.66.1-1Z",
    search: "M7.2 11.9a4.7 4.7 0 1 0 0-9.4 4.7 4.7 0 0 0 0 9.4Z M10.7 10.7 14 14",
    "chevron-right": "M6 3.5 10.5 8 6 12.5",
    "chevron-down": "M3.5 6 8 10.5 12.5 6",
    "chevron-up": "M3.5 10 8 5.5 12.5 10",
    expand: "M6 3.5 10.5 8 6 12.5 M2.5 3.5v9",
    collapse: "M10 3.5 5.5 8 10 12.5 M13.5 3.5v9",
    sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M8 1.5v1.5 M8 13v1.5 M1.5 8h1.5 M13 8h1.5 M3.4 3.4l1 1 M11.6 11.6l1 1 M12.6 3.4l-1 1 M4.4 11.6l-1 1",
    moon: "M13 9.4A5.5 5.5 0 0 1 6.6 3 5.5 5.5 0 1 0 13 9.4Z",
    auto: "M2.5 3.5h11v7h-11z M5.5 13.5h5",
    copy: "M5.5 5.5V3.6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1.9 M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z",
    list: "M3 4.5h10 M3 8h10 M3 11.5h6",
    filter: "M2.5 3.5h11L9.5 8.4v4.1l-3 1.5V8.4z",
    warning: "M8 2.5 14.5 13.5h-13L8 2.5Z M8 6.5v3.2 M8 11.6v.4",
  };

  interface Props {
    name: IconName;
    size?: number;
  }

  let { name, size = 16 }: Props = $props();
  const path = $derived(PATHS[name]);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#each path.split(" M") as segment, i (i)}
    <path d={i === 0 ? segment : `M${segment}`} />
  {/each}
</svg>

<style>
  svg {
    flex: none;
    display: block;
  }
</style>
