<script lang="ts">
  /**
   * Preview text with its escape sequences set apart.
   *
   * Run together in one colour, `first\nsecond` reads as a word with stray
   * letters glued to it. The chip gives the escape a boundary, which is what
   * actually separates it — the hue alone is not enough on top of the value
   * colours already in use.
   */
  import { splitEscapes } from "./escapes";

  interface Props {
    text: string;
  }

  let { text }: Props = $props();
  const segments = $derived(splitEscapes(text));
</script>

{#each segments as segment, i (i)}{#if segment.escape}<span
      class="escape"
      title="이스케이프 시퀀스 — 복사하면 실제 문자로 들어갑니다">{segment.text}</span
    >{:else}{segment.text}{/if}{/each}

<style>
  .escape {
    /* Tinted from the value's own colour so the escape stays associated with
       it, and readable on the selected row without a second set of tokens. */
    color: var(--json-escape);
    background: color-mix(in srgb, var(--json-escape) 16%, transparent);
    border-radius: 2px;
    /* Inline padding only: vertical padding would push the row grid around. */
    padding: 0 0.1em;
  }
</style>
