use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::sync::OnceLock;

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::nodes::Sourcepos;
use serde::Serialize;
use syntect::html::{ClassStyle, ClassedHTMLGenerator, css_for_theme_with_class_style};
use syntect::parsing::SyntaxSet;
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
}

impl SyntaxHighlighterAdapter for SyntectHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let syntax = lang
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .and_then(|l| {
                self.syntaxes
                    .find_syntax_by_token(l)
                    .or_else(|| self.syntaxes.find_syntax_by_extension(l))
            })
            .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());

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
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        output.write_str("<pre class=\"mermaid-source\">")?;
        comrak::html::escape(output, code)?;
        output.write_str("</pre>")
    }
}

static HIGHLIGHTER: OnceLock<SyntectHighlighter> = OnceLock::new();
static MERMAID: MermaidRenderer = MermaidRenderer;

pub fn highlighter() -> &'static SyntectHighlighter {
    HIGHLIGHTER.get_or_init(SyntectHighlighter::new)
}

pub fn codefence_renderers() -> HashMap<String, &'static dyn CodefenceRendererAdapter> {
    MERMAID_LANGS
        .iter()
        .map(|lang| ((*lang).to_owned(), &MERMAID as &dyn CodefenceRendererAdapter))
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
