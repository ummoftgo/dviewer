import { tick } from "svelte";
import { waitSearch } from "./components/markdown/searchSmoke";
import { NOTICES_FILE } from "./notices-open";
import { workspace } from "./state/docs.svelte";

const require = (ok: unknown, why: string) => { if (!ok) throw new Error(why); };

/**
 * Settings → About → Third-party licenses, clicked as a reader would: the tab
 * opens, and the document holds every part the build put in it — PDF.js's
 * files, the KaTeX fonts' table entry, a Rust crate from cargo-about, and
 * dviewer's own MIT licence.
 */
export async function checkNotices() {
  const started = performance.now();
  const settings = document.querySelector<HTMLButtonElement>('[data-action="settings"]');
  require(settings, "Settings button missing");
  settings!.click();
  await tick();
  await waitSearch(() => !!document.querySelector('[data-action="third-party-licenses"]'), "Third-party licenses button missing");
  document.querySelector<HTMLButtonElement>('[data-action="third-party-licenses"]')!.click();
  let tab = workspace.active;
  await waitSearch(() => {
    tab = workspace.active;
    return !!tab && tab.meta.title === NOTICES_FILE && tab.html !== null;
  }, "Third-party notices tab did not open", 30000);
  require(!document.querySelector('[data-action="third-party-licenses"]'), "Settings stayed open over the notices");
  const html = tab!.html!;
  for (const [needle, what] of [[/pdf\.js/i, "PDF.js"], [/KaTeX/, "KaTeX"], [/cssparser/, "a Rust crate (cssparser)"], [/MIT License/, "MIT License"]] as const)
    require(needle.test(html), `Third-party notices lack ${what}`);
  const metrics = { bytes: html.length, ms: Math.round(performance.now() - started) };
  await workspace.close(tab!.id);
  await tick();
  return metrics;
}
