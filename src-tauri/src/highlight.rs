use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::sync::OnceLock;

use comrak::adapters::{CodefenceRendererAdapter, SyntaxHighlighterAdapter};
use comrak::nodes::Sourcepos;
use serde::Serialize;
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
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
    extra: OnceLock<SyntaxSet>,
}

impl SyntectHighlighter {
    fn new() -> Self {
        Self {
            syntaxes: SyntaxSet::load_defaults_newlines(),
            extra: OnceLock::new(),
        }
    }

    fn syntax(&self, lang: Option<&str>, code: &str) -> (&SyntaxSet, &SyntaxReference, bool) {
        let lang = lang.unwrap_or_default().trim();
        fn find<'a>(set: &'a SyntaxSet, lang: &str, code: &str) -> Option<&'a SyntaxReference> {
            if lang.is_empty() {
                set.find_syntax_by_first_line(code.lines().next().unwrap_or_default())
            } else {
                set.find_syntax_by_name(lang)
                    .or_else(|| set.find_syntax_by_token(lang))
                    .or_else(|| set.find_syntax_by_extension(lang))
            }
        }
        // Keep the original grammars (including their embedded grammars) intact.
        if let Some(syntax) = find(&self.syntaxes, lang, code) {
            return (&self.syntaxes, syntax, false);
        }
        let extra = self.extra.get_or_init(two_face::syntax::extra_newlines);
        if let Some(syntax) = find(extra, lang, code) {
            return (extra, syntax, false);
        }
        (
            &self.syntaxes,
            self.syntaxes.find_syntax_plain_text(),
            !lang.is_empty(),
        )
    }

    fn selected_syntax(&self, name: &str, code: &str) -> (&SyntaxSet, &SyntaxReference, bool) {
        let name = name.trim();
        if let Some(syntax) = self.syntaxes.find_syntax_by_name(name) {
            return (&self.syntaxes, syntax, false);
        }
        let extra = self.extra.get_or_init(two_face::syntax::extra_newlines);
        if let Some(syntax) = extra.find_syntax_by_name(name) {
            return (extra, syntax, false);
        }
        self.syntax(Some(name), code)
    }
}

impl SyntaxHighlighterAdapter for SyntectHighlighter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let (syntaxes, syntax, _) = self.syntax(lang, code);
        write_syntax(output, syntaxes, syntax, code)
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

fn write_syntax(
    output: &mut dyn fmt::Write,
    syntaxes: &SyntaxSet,
    syntax: &SyntaxReference,
    code: &str,
) -> fmt::Result {
    let mut generator = ClassedHTMLGenerator::new_with_class_style(syntax, syntaxes, CLASS_STYLE);
    for line in LinesWithEndings::from(code) {
        // Preserve the source even if a grammar cannot parse this input.
        if generator
            .parse_html_for_line_which_includes_newline(line)
            .is_err()
        {
            return comrak::html::escape(output, code);
        }
    }
    output.write_str(&generator.finalize())
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
    let (_, syntax, unknown) = highlighter().syntax(Some(lang), code);
    CodeLanguage {
        name: syntax.name.clone(),
        unknown: unknown.then(|| lang.to_owned()),
    }
}

pub fn highlight_languages() -> Vec<HighlightLanguage> {
    let current = highlighter();
    let extra = current.extra.get_or_init(two_face::syntax::extra_newlines);
    current
        .syntaxes
        .syntaxes()
        .iter()
        .chain(
            extra
                .syntaxes()
                .iter()
                .filter(|s| current.syntaxes.find_syntax_by_name(&s.name).is_none()),
        )
        .filter(|s| !s.hidden)
        .map(|s| HighlightLanguage {
            name: s.name.clone(),
            tokens: s.file_extensions.clone(),
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct HighlightedCode {
    pub html: String,
    pub language: CodeLanguage,
}

pub fn highlight_code(lang: &str, code: &str) -> HighlightedCode {
    let (syntaxes, syntax, unknown) = highlighter().selected_syntax(lang, code);
    let mut html = String::new();
    let _ = write_syntax(&mut html, syntaxes, syntax, code);
    HighlightedCode {
        html,
        language: CodeLanguage {
            name: syntax.name.clone(),
            unknown: unknown.then(|| lang.to_owned()),
        },
    }
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
    fn typescript_tokens_select_the_extension() {
        for token in ["typescript", "ts"] {
            let lang = code_language(token, "const x: number = 1;");
            assert_eq!(lang.name, "TypeScript");
            assert_eq!(lang.unknown, None);
        }
    }

    #[test]
    fn tsx_toml_and_dockerfile_tokens_select_the_extension() {
        for (token, name) in [
            ("tsx", "TypeScriptReact"),
            ("toml", "TOML"),
            ("dockerfile", "Dockerfile"),
        ] {
            let lang = code_language(token, "");
            assert_eq!(lang.name, name);
            assert_eq!(lang.unknown, None);
        }
    }

    #[test]
    fn added_grammars_highlight_and_escape_markup() {
        for (token, code) in [
            ("ts", "const x: string = '<script>';\n"),
            ("tsx", "const x = <div>hello</div>;\n"),
            ("toml", "x = '<script>'\n"),
            ("dockerfile", "FROM alpine\nRUN echo '<script>'\n"),
        ] {
            let html = highlight_code(token, code).html;
            assert!(html.contains("hl-"), "{token}");
            assert!(html.contains("&lt;"), "{token}");
            assert!(!html.contains("<script>"), "{token}");
            assert!(!html.contains("<div>"), "{token}");
        }
    }

    #[test]
    fn all_original_names_and_tokens_keep_the_original_set_without_loading_extra() {
        let current = SyntectHighlighter::new();
        assert_eq!(current.syntaxes.syntaxes().len(), 75);
        for syntax in current.syntaxes.syntaxes() {
            for token in std::iter::once(&syntax.name).chain(syntax.file_extensions.iter()) {
                let (set, _, unknown) = current.syntax(Some(token), "#!/bin/bash");
                assert!(std::ptr::eq(set, &current.syntaxes), "{token}");
                assert!(!unknown, "{token}");
            }
        }
        assert!(current.extra.get().is_none());
    }

    #[test]
    fn first_line_guess_keeps_old_priority_and_can_load_new_grammars() {
        let current = SyntectHighlighter::new();
        for (code, name) in [
            ("#!/bin/bash", "Bourne Again Shell (bash)"),
            ("<?xml version=\"1.0\"?>", "XML"),
        ] {
            let (set, syntax, _) = current.syntax(None, code);
            assert!(std::ptr::eq(set, &current.syntaxes));
            assert_eq!(syntax.name, name);
        }
        assert!(current.extra.get().is_none());
        assert_eq!(current.syntax(None, "FROM alpine\n").1.name, "Dockerfile");
        assert!(current.extra.get().is_some());
    }

    #[test]
    fn expanded_language_list_has_no_duplicates_or_hidden_entries() {
        let langs = highlight_languages();
        let names: std::collections::HashSet<_> = langs.iter().map(|l| &l.name).collect();
        assert_eq!(names.len(), langs.len());
        for lang in &langs {
            assert!(!highlighter().syntax(Some(&lang.name), "").1.hidden);
        }
    }

    #[test]
    fn fish_and_sass_fences_keep_the_original_token_grammars() {
        let current = SyntectHighlighter::new();
        for (token, name) in [("fish", "Bourne Again Shell (bash)"), ("sass", "Ruby Haml")] {
            let (set, syntax, unknown) = current.syntax(Some(token), "set value hello\n");
            assert!(std::ptr::eq(set, &current.syntaxes));
            assert_eq!(syntax.name, name);
            assert!(!unknown);
            let mut expected = String::new();
            write_syntax(
                &mut expected,
                &current.syntaxes,
                current.syntaxes.find_syntax_by_name(name).unwrap(),
                "set value hello\n",
            )
            .unwrap();
            let mut actual = String::new();
            current
                .write_highlighted(&mut actual, Some(token), "set value hello\n")
                .unwrap();
            assert_eq!(actual, expected);
        }
        assert!(current.extra.get().is_none());
    }

    #[test]
    fn selected_fish_and_sass_use_the_exact_extra_grammar_and_report_its_name() {
        for name in ["Fish", "Sass"] {
            let extra = highlighter()
                .extra
                .get_or_init(two_face::syntax::extra_newlines);
            let mut expected = String::new();
            write_syntax(
                &mut expected,
                extra,
                extra.find_syntax_by_name(name).unwrap(),
                "set value hello\n",
            )
            .unwrap();
            let actual = highlight_code(name, "set value hello\n");
            assert_eq!(actual.language.name, name);
            assert_eq!(actual.language.unknown, None);
            assert_eq!(actual.html, expected);
        }
        assert_eq!(
            highlight_code("js", "const x = 1;").language.name,
            "JavaScript"
        );
    }

    #[test]
    fn selecting_original_names_keeps_the_original_grammar_and_lazy_load() {
        let current = SyntectHighlighter::new();
        for original in current.syntaxes.syntaxes() {
            let (set, syntax, unknown) = current.selected_syntax(&original.name, "#!/bin/bash");
            assert!(std::ptr::eq(set, &current.syntaxes));
            assert!(std::ptr::eq(syntax, original));
            assert!(!unknown);
        }
        assert!(current.extra.get().is_none());
    }
    #[test]
    fn known_language_escapes_code() {
        let html = highlight_code("rust", "fn main() { let s = \"<script>\"; }\n").html;
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
        assert_eq!(highlight_code("rust", "").html, "");
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
        assert_eq!(langs.len(), 193);
        assert!(langs.iter().any(|l| l.tokens.iter().any(|t| t == "rs")));
        for lang in langs {
            assert_eq!(
                highlight_code(&lang.name, "#!/bin/bash").language.name,
                lang.name
            );
        }
        assert_eq!(
            code_language("Plain Text", "#!/bin/bash").name,
            "Plain Text"
        );
    }

    // Captured from syntect 5.3.0 defaults before adding two-face, including embedded JS.
    #[test]
    fn original_highlight_html_matches_pre_extension_golden() {
        const GOLDEN: &[(&str, &str, &str)] = &[
            (
                r###"rust"###,
                r###"fn main() { let x = 42; }
"###,
                r###"<span class="hl-source hl-rust"><span class="hl-meta hl-function hl-rust"><span class="hl-meta hl-function hl-rust"><span class="hl-storage hl-type hl-function hl-rust">fn</span> </span><span class="hl-entity hl-name hl-function hl-rust">main</span></span><span class="hl-meta hl-function hl-rust"><span class="hl-meta hl-function hl-parameters hl-rust"><span class="hl-punctuation hl-section hl-parameters hl-begin hl-rust">(</span></span><span class="hl-meta hl-function hl-rust"><span class="hl-meta hl-function hl-parameters hl-rust"><span class="hl-punctuation hl-section hl-parameters hl-end hl-rust">)</span></span></span></span><span class="hl-meta hl-function hl-rust"> </span><span class="hl-meta hl-function hl-rust"><span class="hl-meta hl-block hl-rust"><span class="hl-punctuation hl-section hl-block hl-begin hl-rust">{</span> <span class="hl-storage hl-type hl-rust">let</span> x <span class="hl-keyword hl-operator hl-rust">=</span> <span class="hl-constant hl-numeric hl-integer hl-decimal hl-rust">42</span><span class="hl-punctuation hl-terminator hl-rust">;</span> </span><span class="hl-meta hl-block hl-rust"><span class="hl-punctuation hl-section hl-block hl-end hl-rust">}</span></span></span>
</span>"###,
            ),
            (
                r###"js"###,
                r###"const f = (x) => x + 1;
"###,
                r###"<span class="hl-source hl-js"><span class="hl-storage hl-type hl-js">const</span> <span class="hl-meta hl-function hl-declaration hl-js"><span class="hl-variable hl-other hl-readwrite hl-js"><span class="hl-entity hl-name hl-function hl-js">f</span></span> <span class="hl-keyword hl-operator hl-assignment hl-js">=</span> </span><span class="hl-meta hl-function hl-declaration hl-js"><span class="hl-punctuation hl-section hl-group hl-begin hl-js">(</span><span class="hl-variable hl-parameter hl-function hl-js">x</span><span class="hl-punctuation hl-section hl-group hl-end hl-js">)</span><span class="hl-meta hl-function hl-declaration hl-js"> </span><span class="hl-storage hl-type hl-function hl-arrow hl-js">=&gt;</span></span> <span class="hl-meta hl-block hl-js"><span class="hl-variable hl-other hl-readwrite hl-js">x</span> <span class="hl-keyword hl-operator hl-arithmetic hl-js">+</span> <span class="hl-constant hl-numeric hl-js">1</span></span><span class="hl-punctuation hl-terminator hl-statement hl-js">;</span>
</span>"###,
            ),
            (
                r###"py"###,
                r###"def foo(x): return x + 1
"###,
                r###"<span class="hl-source hl-python"><span class="hl-meta hl-function hl-python"><span class="hl-storage hl-type hl-function hl-python">def</span> <span class="hl-entity hl-name hl-function hl-python"><span class="hl-meta hl-generic-name hl-python">foo</span></span></span><span class="hl-meta hl-function hl-parameters hl-python"><span class="hl-punctuation hl-section hl-parameters hl-begin hl-python">(</span></span><span class="hl-meta hl-function hl-parameters hl-python"><span class="hl-variable hl-parameter hl-python">x</span><span class="hl-punctuation hl-section hl-parameters hl-end hl-python">)</span></span><span class="hl-meta hl-function hl-python"><span class="hl-punctuation hl-section hl-function hl-begin hl-python">:</span></span> <span class="hl-keyword hl-control hl-flow hl-return hl-python">return</span> <span class="hl-meta hl-qualified-name hl-python"><span class="hl-meta hl-generic-name hl-python">x</span></span> <span class="hl-keyword hl-operator hl-arithmetic hl-python">+</span> <span class="hl-constant hl-numeric hl-integer hl-decimal hl-python">1</span>
</span>"###,
            ),
            (
                r###"json"###,
                r###"{"key": true}
"###,
                r###"<span class="hl-source hl-json"><span class="hl-meta hl-structure hl-dictionary hl-json"><span class="hl-punctuation hl-section hl-dictionary hl-begin hl-json">{</span><span class="hl-meta hl-structure hl-dictionary hl-key hl-json"><span class="hl-string hl-quoted hl-double hl-json"><span class="hl-punctuation hl-definition hl-string hl-begin hl-json">&quot;</span>key<span class="hl-punctuation hl-definition hl-string hl-end hl-json">&quot;</span></span></span><span class="hl-meta hl-structure hl-dictionary hl-value hl-json"><span class="hl-punctuation hl-separator hl-dictionary hl-key-value hl-json">:</span> <span class="hl-constant hl-language hl-json">true</span></span><span class="hl-punctuation hl-section hl-dictionary hl-end hl-json">}</span></span>
</span>"###,
            ),
            (
                r###"sh"###,
                r###"#!/bin/bash
echo hello
"###,
                r###"<span class="hl-source hl-shell hl-bash"><span class="hl-comment hl-line hl-number-sign hl-shell"><span class="hl-punctuation hl-definition hl-comment hl-begin hl-shell">#</span></span><span class="hl-comment hl-line hl-number-sign hl-shell">!/bin/bash</span><span class="hl-comment hl-line hl-number-sign hl-shell">
</span><span class="hl-meta hl-function-call hl-shell"><span class="hl-support hl-function hl-echo hl-shell">echo</span></span><span class="hl-meta hl-function-call hl-arguments hl-shell"> hello</span>
</span>"###,
            ),
            (
                r###"xml"###,
                r###"<?xml version="1.0"?><r>ok</r>
"###,
                r###"<span class="hl-text hl-xml"><span class="hl-meta hl-tag hl-preprocessor hl-xml"><span class="hl-punctuation hl-definition hl-tag hl-begin hl-xml">&lt;?</span><span class="hl-entity hl-name hl-tag hl-xml">xml</span> <span class="hl-entity hl-other hl-attribute-name hl-localname hl-xml">version</span><span class="hl-punctuation hl-separator hl-key-value hl-xml">=</span><span class="hl-string hl-quoted hl-double hl-xml"><span class="hl-punctuation hl-definition hl-string hl-begin hl-xml">&quot;</span>1.0<span class="hl-punctuation hl-definition hl-string hl-end hl-xml">&quot;</span></span><span class="hl-punctuation hl-definition hl-tag hl-end hl-xml">?&gt;</span></span><span class="hl-meta hl-tag hl-xml"><span class="hl-punctuation hl-definition hl-tag hl-begin hl-xml">&lt;</span><span class="hl-entity hl-name hl-tag hl-localname hl-xml">r</span><span class="hl-punctuation hl-definition hl-tag hl-end hl-xml">&gt;</span></span>ok<span class="hl-meta hl-tag hl-xml"><span class="hl-punctuation hl-definition hl-tag hl-begin hl-xml">&lt;/</span><span class="hl-entity hl-name hl-tag hl-localname hl-xml">r</span><span class="hl-punctuation hl-definition hl-tag hl-end hl-xml">&gt;</span></span>
</span>"###,
            ),
            (
                r###"html"###,
                r###"<script>let x = 1;</script>
"###,
                r###"<span class="hl-text hl-html hl-basic"><span class="hl-meta hl-tag hl-script hl-begin hl-html"><span class="hl-punctuation hl-definition hl-tag hl-begin hl-html">&lt;</span><span class="hl-entity hl-name hl-tag hl-script hl-html">script</span></span><span class="hl-meta hl-tag hl-script hl-begin hl-html"><span class="hl-punctuation hl-definition hl-tag hl-end hl-html">&gt;</span></span><span class="hl-source hl-js hl-embedded hl-html"><span class="hl-source hl-js"><span class="hl-storage hl-type hl-js">let</span> <span class="hl-variable hl-other hl-readwrite hl-js">x</span> <span class="hl-keyword hl-operator hl-assignment hl-js">=</span> <span class="hl-constant hl-numeric hl-js">1</span><span class="hl-punctuation hl-terminator hl-statement hl-js">;</span></span></span><span class="hl-meta hl-tag hl-script hl-end hl-html"><span class="hl-punctuation hl-definition hl-tag hl-begin hl-html">&lt;/</span><span class="hl-entity hl-name hl-tag hl-script hl-html">script</span><span class="hl-punctuation hl-definition hl-tag hl-end hl-html">&gt;</span></span>
</span>"###,
            ),
            (
                r###"md"###,
                r###"# Hello
**bold**
"###,
                r###"<span class="hl-text hl-html hl-markdown"><span class="hl-meta hl-block-level hl-markdown"><span class="hl-markup hl-heading hl-1 hl-markdown"><span class="hl-punctuation hl-definition hl-heading hl-begin hl-markdown">#</span> </span><span class="hl-markup hl-heading hl-1 hl-markdown"><span class="hl-entity hl-name hl-section hl-markdown">Hello</span><span class="hl-meta hl-whitespace hl-newline hl-markdown">
</span></span></span><span class="hl-meta hl-paragraph hl-markdown"><span class="hl-markup hl-bold hl-markdown"><span class="hl-punctuation hl-definition hl-bold hl-begin hl-markdown">**</span>bold<span class="hl-punctuation hl-definition hl-bold hl-end hl-markdown">**</span></span>
</span></span>"###,
            ),
        ];
        for &(lang, code, html) in GOLDEN {
            let mut fence = String::new();
            highlighter()
                .write_highlighted(&mut fence, Some(lang), code)
                .unwrap();
            assert_eq!(fence, html, "fence {lang}");
            assert_eq!(highlight_code(lang, code).html, html, "selection {lang}");
        }
    }
}
