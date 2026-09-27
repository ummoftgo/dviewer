/**
 * THIRD-PARTY-NOTICES, the pure parts.
 *
 * The Vite plugin (vite.config.ts) feeds `bundledPackages` the build's module
 * ids; `scripts/notices.mjs` reads the packages' files and the other parts and
 * puts them together with `assembleNotices`. Kept free of I/O so vitest holds
 * the rules: only what the bundle actually contains, the innermost package of
 * a nested `node_modules`, and every licence text fenced so Markdown leaves it
 * alone.
 */

/** A package the bundle drew modules from: its name and its directory. */
export interface BundledPackage { name: string; dir: string }

/**
 * The packages behind a build's module ids, sorted by name then directory.
 * Vite marks virtual modules with a leading NUL and may carry a `?query`; ids
 * outside any `node_modules` are our own source and are left out.
 */
export function bundledPackages(ids: Iterable<string>): BundledPackage[] {
  const found = new Map<string, BundledPackage>();
  for (const raw of ids) {
    const id = raw.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/");
    const at = id.lastIndexOf("node_modules/");
    if (at < 0 || (at > 0 && id[at - 1] !== "/")) continue;
    const parts = id.slice(at + "node_modules/".length).split("/");
    const name = parts[0].startsWith("@") ? (parts[1] ? `${parts[0]}/${parts[1]}` : "") : parts[0];
    if (!name || name.startsWith(".")) continue;
    const dir = id.slice(0, at + "node_modules/".length) + name;
    found.set(dir, { name, dir });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

/** A fence longer than any run of backticks inside, so no licence text can close it. */
export function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = "`".repeat(Math.max(4, longest + 1));
  return `${marks}text\n${text.replace(/\r\n/g, "\n").trimEnd()}\n${marks}`;
}

/** One bundled package as the notices print it. */
export interface NpmPackage {
  name: string;
  version: string;
  license: string;
  author?: string;
  /** LICENCE, NOTICE and COPYING files found in the package, with their text. */
  files: { name: string; text: string }[];
}

export function npmSection(packages: NpmPackage[]): string {
  const out = ["## JavaScript packages", "", "Bundled into dviewer's frontend, as found in the build's module graph.", ""];
  for (const pkg of packages) {
    out.push(`### ${pkg.name} ${pkg.version} — ${pkg.license}`, "");
    if (!pkg.files.length) {
      // fastdom is one: MIT by its package.json, with no licence file shipped.
      out.push(`The package ships no licence file; its package.json declares ${pkg.license}${pkg.author ? `, by ${pkg.author}` : ""}.`, "");
    }
    for (const file of pkg.files) out.push(`${file.name}:`, "", fence(file.text), "");
  }
  return out.join("\n");
}

export interface NoticeParts {
  version: string;
  license: string;
  staticPart: string;
  pdfjs: { version: string; files: { name: string; text: string }[] };
  rust: string;
  npm: string;
}

/** The whole document, dviewer's own licence first. */
export function assembleNotices(parts: NoticeParts): string {
  return [
    "# Third-party notices",
    "",
    `dviewer ${parts.version} is released under the MIT License, below. It ships with the components listed in this document, each under its own licence.`,
    "",
    "## dviewer",
    "",
    fence(parts.license),
    "",
    parts.staticPart.trimEnd(),
    "",
    `## PDF.js ${parts.pdfjs.version}`,
    "",
    "The PDF viewer, with the licence files it ships for its character maps, fonts, colour profiles and image decoders.",
    "",
    ...parts.pdfjs.files.flatMap((file) => [`### ${file.name}`, "", fence(file.text), ""]),
    parts.rust.trimEnd(),
    "",
    parts.npm.trimEnd(),
    "",
  ].join("\n");
}
