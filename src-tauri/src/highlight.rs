use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::sync::OnceLock;

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::nodes::Sourcepos;
use serde::Serialize;
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::{SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Class-based highlighting (not inline styles) is what makes the light/dark
/// switch free: the markup never changes, only which stylesheet is active.
const CLASS_STYLE: ClassStyle = ClassStyle::SpacedPrefixed { prefix: "hl-" };

const LIGHT_THEME: &str = "InspiredGitHub";
const DARK_THEME: &str = "base16-ocean.dark";

/// Fences we hand to the frontend untouched instead of highlighting.
const MERMAID_LANGS: &[&str] = &["mermaid"];

pub struct SyntectHighlighter {
    syntaxes: SyntaxSet,
}

impl SyntectHighlighter {
    fn new() -> Self {
        Self {
            syntaxes: SyntaxSet::load_defaults_newlines(),
        }
    }

    fn syntax(&self, lang: Option<&str>, code: &str) -> (&SyntaxReference, bool) {
        let lang = lang.unwrap_or_default().trim();
        let found = if lang.is_empty() {
            self.syntaxes
                .find_syntax_by_first_line(code.lines().next().unwrap_or_default())
        } else {
            self.syntaxes
                .find_syntax_by_name(lang)
                .or_else(|| self.syntaxes.find_syntax_by_token(lang))
                .or_else(|| self.syntaxes.find_syntax_by_extension(lang))
        };
        (
            found.unwrap_or_else(|| self.syntaxes.find_syntax_plain_text()),
            !lang.is_empty() && found.is_none(),
        )
    }
}

impl SyntaxHighlighterAdapter for SyntectHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let (syntax, _) = self.syntax(lang, code);

        let mut generator =
            ClassedHTMLGenerator::new_with_class_style(syntax, &self.syntaxes, CLASS_STYLE);

        for line in LinesWithEndings::from(code) {
            // A syntax that trips on this input must not cost us the block —
            // fall back to plain escaped source.
            if generator
                .parse_html_for_line_which_includes_newline(line)
                .is_err()
            {
                return comrak::html::escape(output, code);
            }
        }

        output.write_str(&generator.finalize())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        comrak::html::write_opening_tag(output, "pre", attributes)
    }

    fn write_code_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        comrak::html::write_opening_tag(output, "code", attributes)
    }
}

/// Emits mermaid fences as inert, escaped source. The frontend swaps them for
/// rendered SVG — doing it here would mean shipping a JS engine to Rust.
pub struct MermaidRenderer;

impl CodefenceRendererAdapter for MermaidRenderer {
    fn write(
        &self,
        output: &mut dyn fmt::Write,
        _lang: &str,
        _meta: &str,
        code: &str,
        sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        output.write_str("<pre class=\"mermaid-source\"")?;
        if let Some(pos) = sourcepos {
            write!(output, " data-sourcepos=\"{pos}\"")?;
        }
        output.write_str(">")?;
        comrak::html::escape(output, code)?;
        output.write_str("</pre>")
    }
}

static HIGHLIGHTER: OnceLock<SyntectHighlighter> = OnceLock::new();
static MERMAID: MermaidRenderer = MermaidRenderer;

pub fn highlighter() -> &'static SyntectHighlighter {
    HIGHLIGHTER.get_or_init(SyntectHighlighter::new)
}

#[derive(Debug, Clone, Serialize)]
pub struct HighlightLanguage {
    pub name: String,
    pub tokens: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodeLanguage {
    pub name: String,
    pub unknown: Option<String>,
}

pub fn code_language(lang: &str, code: &str) -> CodeLanguage {
    let (syntax, unknown) = highlighter().syntax(Some(lang), code);
    CodeLanguage {
        name: syntax.name.clone(),
        unknown: unknown.then(|| lang.to_owned()),
    }
}

pub fn highlight_languages() -> Vec<HighlightLanguage> {
    highlighter()
        .syntaxes
        .syntaxes()
        .iter()
        .filter(|s| !s.hidden)
        .map(|s| HighlightLanguage {
            name: s.name.clone(),
            tokens: s.file_extensions.clone(),
        })
        .collect()
}

pub fn highlight_code(lang: &str, code: &str) -> String {
    let mut html = String::new();
    let _ = highlighter().write_highlighted(&mut html, Some(lang), code);
    html
}

pub fn codefence_renderers() -> HashMap<String, &'static dyn CodefenceRendererAdapter> {
    MERMAID_LANGS
        .iter()
        .map(|lang| {
            (
                (*lang).to_owned(),
                &MERMAID as &dyn CodefenceRendererAdapter,
            )
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HighlightCss {
    pub light: String,
    pub dark: String,
}

static CSS: OnceLock<HighlightCss> = OnceLock::new();

/// Both theme stylesheets, generated once. The frontend keeps both and swaps
/// the active one on theme change, so no document is ever re-rendered.
pub fn highlight_css() -> &'static HighlightCss {
    CSS.get_or_init(|| {
        let themes = syntect::highlighting::ThemeSet::load_defaults();
        HighlightCss {
            light: theme_css(&themes, LIGHT_THEME),
            dark: theme_css(&themes, DARK_THEME),
        }
    })
}

fn theme_css(themes: &syntect::highlighting::ThemeSet, name: &str) -> String {
    let Some(theme) = themes.themes.get(name) else {
        return String::new();
    };
    match css_for_theme_with_class_style(theme, CLASS_STYLE) {
        Ok(css) => strip_root_rule(&css),
        Err(err) => {
            let mut out = String::new();
            let _ = write!(out, "/* syntect theme {name} failed: {err} */");
            out
        }
    }
}

/// syntect emits a `.hl-code { background/color }` rule for the theme's own
/// chrome. We paint the code block from our own tokens, so drop it — otherwise
/// the two disagree at the edges of the block.
fn strip_root_rule(css: &str) -> String {
    css.split_inclusive('}')
        .filter(|rule| !rule.trim_start().starts_with(".hl-code "))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_language_escapes_code() {
        let html = highlight_code("rust", "fn main() { let s = \"<script>\"; }\n");
        assert!(html.contains("hl-"));
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
    }
    #[test]
    fn unknown_explicit_language_does_not_guess() {
        let lang = code_language("not-a-syntax", "#!/bin/bash\necho hi");
        assert_eq!(lang.name, "Plain Text");
        assert_eq!(lang.unknown.as_deref(), Some("not-a-syntax"));
    }
    #[test]
    fn empty_code_is_empty() {
        assert_eq!(highlight_code("rust", ""), "");
    }
    #[test]
    fn empty_fence_guesses_bash() {
        assert_eq!(
            code_language("", "#!/bin/bash\necho hi").name,
            "Bourne Again Shell (bash)"
        );
    }
    #[test]
    fn empty_fence_guesses_xml() {
        assert_eq!(code_language("", "<?xml version=\"1.0\"?>").name, "XML");
    }
    #[test]
    fn json_brace_does_not_guess() {
        assert_eq!(code_language("", "{\n}").name, "Plain Text");
    }
    #[test]
    fn language_names_roundtrip_including_plain() {
        let langs = highlight_languages();
        assert_eq!(langs.len(), 68);
        assert!(langs.iter().any(|l| l.tokens.iter().any(|t| t == "rs")));
        for lang in langs {
            assert_eq!(code_language(&lang.name, "#!/bin/bash").name, lang.name);
        }
        assert_eq!(
            code_language("Plain Text", "#!/bin/bash").name,
            "Plain Text"
        );
    }
}
