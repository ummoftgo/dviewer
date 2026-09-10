import type { CodeLanguage, HighlightLanguage } from '../../ipc';

const FAVORITES = ['JSON', 'YAML', 'TOML', 'XML', 'HTML', 'CSS', 'JavaScript',
  'TypeScript', 'TypeScriptReact', 'Rust', 'Python', 'Bourne Again Shell (bash)',
  'Dockerfile', 'SQL', 'Markdown', 'Plain Text'];

export function favoriteLanguages(languages: HighlightLanguage[]): HighlightLanguage[] {
  return FAVORITES.flatMap((name) => languages.filter((language) => language.name === name));
}

export function languageLabel(language: CodeLanguage, unknown: (name: string) => string): string {
  return language.unknown ? unknown(language.unknown) : language.name;
}
