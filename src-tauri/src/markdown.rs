use std::collections::HashMap;
use std::sync::OnceLock;

use comrak::nodes::{AstNode, NodeValue};
use comrak::options::Plugins;
use comrak::{Arena, Options};
use serde::Serialize;

use crate::highlight;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedMarkdown {
    pub html: String,
    pub toc: Vec<TocEntry>,
    pub code_languages: HashMap<String, highlight::CodeLanguage>,
}

fn options() -> &'static Options<'static> {
    static OPTIONS: OnceLock<Options<'static>> = OnceLock::new();
    OPTIONS.get_or_init(|| {
        let mut o = Options::default();

        // The five GFM extensions plus the ones dev docs actually lean on.
        o.extension.table = true;
        o.extension.strikethrough = true;
        o.extension.tasklist = true;
        o.extension.autolink = true;
        o.extension.tagfilter = true;
        o.extension.footnotes = true;
        o.extension.description_lists = true;
        o.extension.alerts = true;
        o.extension.math_dollars = true;
        o.extension.math_code = true;
        o.extension.header_id_prefix = Some(String::new());
        o.extension.front_matter_delimiter = Some("---".to_owned());

        o.parse.smart = false;

        // Raw HTML is allowed through the renderer and then removed by ammonia.
        // comrak's escaping is all-or-nothing; ammonia can keep <details> while
        // still dropping <script>, which is what a doc viewer wants.
        o.render.r#unsafe = true;
        o.render.tasklist_classes = true;
        o.render.figure_with_caption = true;
        o.render.sourcepos = true;

        o
    })
}

pub fn render(source: &str) -> RenderedMarkdown {
    let options = options();
    let arena = Arena::new();
    let root = comrak::parse_document(&arena, source, options);

    let toc = collect_toc(root);
    let code_languages = root
        .descendants()
        .filter_map(|node| {
            let mut data = node.data.borrow_mut();
            let NodeValue::CodeBlock(code) = &mut data.value else {
                return None;
            };
            // The adapter gets an empty language for indented blocks too.
            // Only unlabelled fences opt into first-line detection.
            if !code.fenced {
                code.info = "text".into();
            }
            let lang = code.info.split_whitespace().next().unwrap_or_default();
            let language = highlight::code_language(lang, &code.literal);
            Some((data.sourcepos.to_string(), language))
        })
        .collect();

    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(highlight::highlighter());
    plugins.render.codefence_renderers = highlight::codefence_renderers();

    let mut raw = String::new();
    // Writing into a String is infallible; the Result is a fmt formality.
    let _ = comrak::format_html_with_plugins(root, options, &mut raw, &plugins);

    RenderedMarkdown {
        html: sanitizer().clean(&raw).to_string(),
        toc,
        code_languages,
    }
}

fn collect_toc<'a>(root: &'a AstNode<'a>) -> Vec<TocEntry> {
    // comrak assigns heading ids with the same anchorizer, so running our own
    // over the headings in document order reproduces them exactly, including
    // the -1/-2 suffixes it adds for duplicate headings.
    let mut anchorizer = comrak::Anchorizer::new();
    let mut toc = Vec::new();

    for node in root.descendants() {
        let NodeValue::Heading(heading) = node.data.borrow().value else {
            continue;
        };
        let text = node_text(node);
        if text.trim().is_empty() {
            continue;
        }
        let id = anchorizer.anchorize(&text);
        toc.push(TocEntry {
            level: heading.level,
            text,
            id,
        });
    }

    toc
}

fn node_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut out = String::new();
    for descendant in node.descendants() {
        match &descendant.data.borrow().value {
            NodeValue::Text(text) => out.push_str(text),
            NodeValue::Code(code) => out.push_str(&code.literal),
            NodeValue::Math(math) => out.push_str(&math.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
            _ => {}
        }
    }
    out.trim().to_owned()
}

fn sanitizer() -> &'static ammonia::Builder<'static> {
    static SANITIZER: OnceLock<ammonia::Builder<'static>> = OnceLock::new();
    SANITIZER.get_or_init(|| {
        let mut builder = ammonia::Builder::default();

        // Tasklists, collapsible sections and GFM alerts all need tags or
        // attributes ammonia strips by default.
        builder
            .add_tags([
                "details",
                "summary",
                "input",
                "figure",
                "figcaption",
                "section",
            ])
            .add_tag_attributes("input", ["type", "checked", "disabled"])
            .add_tag_attributes("span", ["data-math-style"])
            .add_tag_attributes("code", ["data-math-style"])
            .add_tag_attributes(
                "a",
                ["aria-label", "data-heading-content", "data-footnote-ref"],
            )
            .add_tag_attributes("li", ["data-footnote-backref", "data-footnote-backref-idx"])
            // Drop the bodies of these, not just their tags — otherwise the
            // page shows raw CSS or JS as prose.
            .clean_content_tags(["script", "style", "iframe", "object", "embed"].into())
            // `class` and `id` carry the highlighter output, heading anchors and
            // footnote links. Neither can execute anything.
            .add_generic_attributes(["class", "id"])
            // Relative image paths must survive — the frontend rewrites them to
            // the asset protocol once it knows the document's directory.
            .url_relative(ammonia::UrlRelative::PassThrough);

        // Inline positions are byte columns too, but only whole blocks can be
        // copied as original lines. Do not make this a generic attribute.
        for tag in [
            "p",
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "ul",
            "ol",
            "li",
            "pre",
            "table",
            "blockquote",
            "details",
            "figure",
            "dl",
            "dt",
            "dd",
            "section",
            "hr",
            "div",
        ] {
            builder.add_tag_attributes(tag, ["data-sourcepos"]);
        }

        builder
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_gfm_tables_and_tasklists() {
        let out = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n");
        assert!(out.html.contains("<table data-sourcepos="));
        assert!(out.html.contains("task-list-item"));
        assert!(out.html.contains("type=\"checkbox\""));
    }

    #[test]
    fn keeps_collapsible_sections() {
        let out = render("<details><summary>더 보기</summary>본문</details>");
        assert!(out.html.contains("<details>"));
        assert!(out.html.contains("<summary>"));
    }

    /// Documents arrive from URLs and clipboards, so the sanitiser is the only
    /// thing between a hostile file and the webview.
    #[test]
    fn active_content_never_survives() {
        let cases = [
            "<script>alert(1)</script>",
            "<img src=x onerror=alert(1)>",
            "<a href=\"javascript:alert(1)\">click</a>",
            "<div onclick=\"alert(1)\">click</div>",
            "<iframe src=\"https://example.com\"></iframe>",
            "<style>body{display:none}</style>",
            "<svg><script>alert(1)</script></svg>",
            "[link](javascript:alert&#40;1&#41;)",
        ];
        for case in cases {
            let html = render(case).html;
            // Raw `<script>` is escaped to text by comrak's tagfilter, exactly
            // as GitHub does, so assert on what could actually execute.
            assert!(
                !html.contains("<script"),
                "script tag survived: {case} -> {html}"
            );
            assert!(
                !html.contains("onerror"),
                "onerror survived: {case} -> {html}"
            );
            assert!(
                !html.contains("onclick"),
                "onclick survived: {case} -> {html}"
            );
            assert!(
                !html.contains("<iframe"),
                "iframe survived: {case} -> {html}"
            );
            assert!(
                !html.contains("javascript:"),
                "javascript: url survived: {case} -> {html}"
            );
        }
    }

    #[test]
    fn mermaid_fences_pass_through_unhighlighted() {
        let out = render("```mermaid\ngraph TD; A-->B;\n```\n");
        assert!(out.html.contains("class=\"mermaid-source\""));
        assert!(out.html.contains("A--&gt;B"));
        assert!(!out.html.contains("hl-"));
    }

    #[test]
    fn code_fences_get_class_based_highlighting() {
        let out = render("```rust\nfn main() {}\n```\n");
        assert!(out.html.contains("language-rust"));
        assert!(out.html.contains("hl-"));
        assert!(!out.html.contains("style=\""));
    }

    #[test]
    fn toc_ids_match_rendered_heading_ids() {
        let out = render("# 제목\n\n## Section\n\n## Section\n");
        let ids: Vec<_> = out.toc.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["제목", "section", "section-1"]);
        for id in ids {
            assert!(
                out.html.contains(&format!("id=\"{id}\"")),
                "missing id {id}"
            );
        }
    }

    #[test]
    fn math_is_marked_for_the_frontend() {
        let out = render(
            r"inline $x^2$ and

$$\int_0^1 x\,dx$$
",
        );
        assert!(out.html.contains("data-math-style=\"inline\""));
        assert!(out.html.contains("data-math-style=\"display\""));
    }
    #[test]
    fn positions_survive_on_paragraph_heading_code_table_and_list() {
        for (source, tag, position) in [
            ("abc\n", "p", "1:1-1:3"),
            ("# abc\n", "h1", "1:1-1:5"),
            ("~~~rust\nfn main() {}\n~~~\n", "pre", "1:1-3:3"),
            ("| a |\n|---|\n| b |\n", "table", "1:1-3:5"),
            ("- a\n- b\n", "ul", "1:1-2:3"),
        ] {
            let html = render(source).html;
            assert!(
                html.contains(&format!("<{tag}"))
                    && html.contains(&format!("data-sourcepos=\"{position}\"")),
                "{html}"
            );
        }
    }
    #[test]
    fn inline_positions_and_arbitrary_data_are_removed() {
        let html =
            render("*abc* <span data-sourcepos=\"1:1-1:3\" data-evil=\"x\">def</span>\n").html;
        assert!(html.contains("<em>abc</em>"));
        assert!(html.contains("<span>def</span>"));
        assert_eq!(html.matches("data-sourcepos").count(), 1);
    }
    #[test]
    fn mermaid_keeps_position() {
        let html = render("~~~mermaid\ngraph TD; A-->B;\n~~~\n").html;
        assert!(html.contains("data-sourcepos=\"1:1-3:3\""));
    }
    #[test]
    fn language_metadata_matches_rendered_fence_position() {
        let out = render("~~~\n#!/bin/bash\necho hi\n~~~\n");
        assert_eq!(
            out.code_languages["1:1-4:3"].name,
            "Bourne Again Shell (bash)"
        );
        assert!(out.html.contains("hl-"));
    }
    #[test]
    fn indented_code_does_not_opt_into_first_line_detection() {
        let out = render("    #!/bin/bash\n    echo hi\n");
        assert_eq!(
            out.code_languages.values().next().unwrap().name,
            "Plain Text"
        );
        assert!(out.html.contains("language-text"));
    }
}
