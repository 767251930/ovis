import { describe, expect, test } from "bun:test";
import { parseMarkdown, type InlineNode } from "./markdown.ts";
import { renderedClipboardPayload, serializeMarkdownTable, type ClipboardNode, type MarkdownTable } from "./markdownClipboard.ts";

const text = (value: string): ClipboardNode => ({ tag: "", text: value });
const element = (tag: string, content: readonly ClipboardNode[], attrs?: Record<string, string>): ClipboardNode => ({ tag, children: content, attrs });

describe("renderedClipboardPayload", () => {
  test("keeps native selected text rather than synthesizing Markdown from formatting", () => {
    const nodes = [
      element("H3", [text("Plan")], { "data-markdown-heading": "1" }),
      element("UL", [
        element("LI", [element("STRONG", [text("First")])]),
        element("LI", [element("A", [text("Docs")], { href: "https://example.com" })]),
      ]),
    ];
    const payload = renderedClipboardPayload(nodes, "Plan\n\nFirst\nDocs");
    expect(payload.text).toBe("Plan\n\nFirst\nDocs");
    expect(payload.html).toBe('<h3>Plan</h3><ul><li><strong>First</strong></li><li><a href="https://example.com">Docs</a></li></ul>');
  });

  test("retains nested ordered lists in rich HTML without adding markers to plain text", () => {
    const nodes = [element("OL", [
      element("LI", [text("Done"), element("UL", [element("LI", [text("Child")])])]),
    ], { start: "3" })];
    expect(renderedClipboardPayload(nodes, "Done\nChild")).toEqual({
      text: "Done\nChild", html: '<ol start="3"><li>Done<ul><li>Child</li></ul></li></ol>',
    });
  });

  test("preserves native whitespace in mixed prose and code and omits copy controls from HTML", () => {
    const code = "  one\n\n\n  two  ";
    const nodes = [element("P", [text("Run this")]), element("DIV", [
      element("DIV", [text("ts"), element("BUTTON", [text("Copy")])], { class: "markdown-code-header" }),
      element("PRE", [element("CODE", [text(code)])]),
    ])];
    expect(renderedClipboardPayload(nodes, ` Run this\n\n${code}\n`)).toEqual({
      text: ` Run this\n\n${code}\n`, html: `<p>Run this</p><pre><code>${code}</code></pre>`,
    });
  });

  test("keeps selected file and fallback image labels without restoring unselected Markdown source", () => {
    const nodes = [element("P", [
      element("BUTTON", [element("CODE", [text("main.ts")])], { class: "markdown-file" }),
      element("SPAN", [text("diagram")], { "data-markdown-copy": '![<diagram>](https://example.com/picture.png)' }),
    ])];
    expect(renderedClipboardPayload(nodes, "main.ts diagram")).toEqual({
      text: "main.ts diagram", html: '<p><code>main.ts</code>diagram</p>',
    });
  });

  test("exports rich HTML without executable attributes, embedded resources, or unsafe links", () => {
    const nodes = [
      element("P", [text('<hello & "world">')], { onclick: "alert(1)", style: "background:url(https://example.com)" }),
      element("SCRIPT", [text("alert(1)")]),
      element("IFRAME", [], { src: "https://example.com" }),
      element("IMG", [], { alt: "picture", src: "https://example.com/p.png", onerror: "alert(1)" }),
      element("A", [text("unsafe")], { href: "javascript:alert(1)" }),
      element("STRONG", [text("safe")]),
      element("SPAN", [text("hidden")], { "aria-hidden": "true" }),
    ];
    expect(renderedClipboardPayload(nodes, "visible").html).toBe('<p>&lt;hello &amp; &quot;world&quot;&gt;</p>picture<a>unsafe</a><strong>safe</strong>');
  });

  test("keeps native selected plain text", () => {
    // a selection across a table copies what the browser selected, never the table's GFM: the
    // copy action above the table is left out of the rich HTML with the other controls
    const nodes = [element("DIV", [
      element("DIV", [element("BUTTON", [], { class: "icon-button markdown-table-copy", "aria-label": "Copy table" })], { class: "markdown-table-header" }),
      element("DIV", [element("TABLE", [
        element("THEAD", [element("TR", [element("TH", [text("Name")]), element("TH", [text("Value")])])]),
        element("TBODY", [element("TR", [element("TD", [text("a")]), element("TD", [element("CODE", [text("x|y")])])])]),
      ])], { class: "markdown-table-wrap" }),
    ], { class: "markdown-table" })];
    const selected = "Name\tValue\na\tx|y";
    expect(renderedClipboardPayload(nodes, selected)).toEqual({
      text: selected,
      html: "<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a</td><td><code>x|y</code></td></tr></tbody></table>",
    });
  });

  test("retains quotes and tables in rich HTML without generating Markdown table delimiters", () => {
    const nodes = [
      element("BLOCKQUOTE", [element("P", [text("Quote")])]),
      element("TABLE", [
        element("THEAD", [element("TR", [element("TH", [text("Name")])])]),
        element("TBODY", [element("TR", [element("TD", [text("a|b")])])]),
      ]),
    ];
    expect(renderedClipboardPayload(nodes, "Quote\n\nName\na|b")).toEqual({
      text: "Quote\n\nName\na|b",
      html: "<blockquote><p>Quote</p></blockquote><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>a|b</td></tr></tbody></table>",
    });
  });
});

describe("serializeMarkdownTable", () => {
  const table = (source: string): MarkdownTable => {
    const [block] = parseMarkdown(source);
    if (block?.type !== "table") throw new Error(`not a table: ${source}`);
    return block;
  };
  const text = (value: string): InlineNode => ({ type: "text", value });
  const cells = (header: InlineNode[][], rows: InlineNode[][][]): MarkdownTable => ({ type: "table", header, rows });

  test("serializes GFM table cells and padding", () => {
    const source = [
      "| Name | Value | Note |",
      "| :--- | ---: | :-: |",
      "| [docs](https://example.com/a) | `code` | **bold** *em* ~~gone~~ 한국어 |",
      "| https://en.wikipedia.org/wiki/Rust_(language) | \\(x_i + 1\\) | [report](/repo/out/REPORT.md) |",
      "| short |",
      "| a | b | c | d (dropped) |",
      "| ![pic](img/a.png) |  | file:///tmp/README.md |",
    ].join("\n");
    const parsed = table(source);
    const gfm = serializeMarkdownTable(parsed);
    expect(gfm).toBe([
      "| Name | Value | Note |",
      "| --- | --- | --- |",
      "| [docs](https://example.com/a) | `code` | **bold** *em* ~~gone~~ 한국어 |",
      "| https://en.wikipedia.org/wiki/Rust_(language) | \\(x_i + 1\\) | [report](/repo/out/REPORT.md) |",
      "| short |  |  |",
      "| a | b | c |",
      "| ![pic](img/a.png) |  | file:///tmp/README.md |",
    ].join("\n"));
    // every row is the header's width: a short row is padded and a long one cut, as GFM reads them
    const rectangular = { ...parsed, rows: parsed.rows.map((row) => Array.from({ length: 3 }, (_, index) => row[index] ?? [])) };
    expect(table(gfm)).toEqual(rectangular);
    expect(serializeMarkdownTable(table(gfm))).toBe(gfm);
    // a cell with no header is still a table; a break inside a cell is one line, as GFM has it
    expect(serializeMarkdownTable(cells([[]], [[[text("one\ntwo")]], [[text("a\u2028b")], [text("ignored")]]]))).toBe("|  |\n| --- |\n| one<br>two |\n| a<br>b |");
    expect(serializeMarkdownTable(cells([[text("only")]], []))).toBe("| only |\n| --- |");
  });

  test("escapes pipes backslashes and code delimiters", () => {
    const row = (...nodes: InlineNode[][]): string => serializeMarkdownTable(cells(nodes.map(() => [text("h")]), [nodes])).split("\n")[2]!;
    // a pipe would end the cell and a backslash would escape what follows; inside a formula the
    // backslashes are its commands and stay
    expect(row([text("a|b")], [text("C:\\Users\\me")], [{ type: "math", value: "\\lvert x \\rvert = |x|" }]))
      .toBe("| a\\|b | C:\\\\Users\\\\me | \\(\\lvert x \\rvert = \\|x\\|\\) |");
    // a code span is fenced by one more backtick than any run inside it, and padded when it starts
    // or ends with one; its pipes are escaped too, since GFM splits the cell before reading spans
    expect(row([{ type: "code", value: "a`b" }], [{ type: "code", value: "``x" }], [{ type: "code", value: "a|b" }], [{ type: "code", value: "back\\slash" }]))
      .toBe("| ``a`b`` | ``` ``x ``` | `a\\|b` | `back\\slash` |");
    // a label's brackets and a destination's spaces, parentheses and pipes would end them early
    const link: InlineNode = { type: "link", href: "https://x.dev/a b(c)|d", children: [text("see [this]")] };
    const file: InlineNode = { type: "file", path: "/tmp/my notes (draft).md", children: [{ type: "strong", children: [text("notes")] }] };
    const image: InlineNode = { type: "image", alt: "a ] b", src: "img/a b.png", fallback: [] };
    expect(row([link], [file], [image])).toBe("| [see \\[this\\]](https://x.dev/a%20b%28c%29%7Cd) | [**notes**](/tmp/my%20notes%20%28draft%29.md) | ![a \\] b](img/a%20b.png) |");
    // read back where the parser reads what was written: an encoded destination stays one address
    // (the parser knows a table from two columns on, and reads no escaped bracket in a label)
    const plain: InlineNode = { ...link, children: [text("see this")] };
    const [back] = table(serializeMarkdownTable(cells([[text("h")], [text("i")]], [[[plain], [text("x")]]]))).rows[0]!;
    expect(back).toEqual([{ type: "link", href: "https://x.dev/a%20b%28c%29%7Cd", children: [text("see this")] }]);
    // nested marks, an empty cell and a long unbroken cell keep their column boundaries
    const long = "x".repeat(5_000);
    const nested = (inner: string): InlineNode => ({ type: "strong", children: [text("a "), { type: "em", children: [{ type: "del", children: [text(inner)] }] }] });
    expect(row([nested("b|c")], [], [text(long)])).toBe(`| **a *~~b\\|c~~*** |  | ${long} |`);
    // read back as written, where the parser reads what GFM does: it reads no `*` inside `**`, so
    // that stays with GFM alone
    const marks: InlineNode[] = [{ type: "strong", children: [text("a "), { type: "del", children: [text("b c")] }] }, text(" "), { type: "em", children: [text("d")] }];
    expect(table(serializeMarkdownTable(cells([[text("h")], [text("i")], [text("j")]], [[marks, [], [text(long)]]]))).rows[0]).toEqual([marks, [], [text(long)]]);
  });

  /**
   * Each cell of the copied table's one row as a GFM reader (Bun's own, with GFM's autolinks)
   * renders it: inner HTML, in order, in one spelling of it (an apostrophe as `&#39;`, a void tag
   * closed without ` /`), so an expectation says what is shown, not how a reader writes HTML.
   */
  const readBack = (gfm: string): string[] => {
    const html = Bun.markdown.html(gfm, { autolinks: true }).replaceAll("'", "&#39;").replaceAll(" />", ">");
    const body = /<tbody>([\s\S]*)<\/tbody>/.exec(html)?.[1] ?? "";
    return [...body.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]!);
  };
  /** the characters a reader sees, as GFM writes them into HTML */
  const shown = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  const oneRow = (nodes: InlineNode[][]): string => serializeMarkdownTable(cells(nodes.map(() => [text("h")]), [nodes]));

  test("reads literal text back from a GFM reader as the characters shown", () => {
    const literals = [
      "<b>literal</b> &copy;", "&#169; &amp; &x", "**not bold** *not em*", "~~kept~~ ~one~", "`not code`",
      "[not](a link) ![not](an image)", "<not-a-tag attr=1>", "a|b", "ends with \\", "C:\\temp\\new",
      "snake_case_name _not em_ __not strong__", "한국어 <i>그대로</i> &lt;", "'quoted' \"twice\" > 1",
    ];
    expect(readBack(oneRow(literals.map((value) => [text(value)])))).toEqual(literals.map(shown));
  });

  test("copies a source cell's escaped pipe as one cell, read back the same by a GFM reader and this parser", () => {
    const copied = serializeMarkdownTable(table("| h1 | h2 |\n| --- | --- |\n| a\\|b | c |"));
    expect(readBack(copied)).toEqual(["a|b", "c"]);
    expect(table(copied).rows[0]).toEqual([[text("a|b")], [text("c")]]);
  });

  test("keeps the formatting the parsed nodes carry", () => {
    const nodes: InlineNode[][] = [
      [{ type: "strong", children: [text("<b>")] }, text(" "), { type: "em", children: [text("a*b")] }, text(" "), { type: "del", children: [text("x~y")] }],
      [{ type: "code", value: "<b>&copy;" }],
      [{ type: "link", href: "https://example.com/a_b", children: [text("see <docs>")] }],
      [{ type: "link", href: "https://example.com/a_b", children: [text("https://example.com/a_b")] }],
      [{ type: "image", alt: "a *pic* [1]", src: "img/a.png", fallback: [] }],
    ];
    expect(readBack(oneRow(nodes))).toEqual([
      "<strong>&lt;b&gt;</strong> <em>a*b</em> <del>x~y</del>",
      "<code>&lt;b&gt;&amp;copy;</code>",
      '<a href="https://example.com/a_b">see &lt;docs&gt;</a>',
      '<a href="https://example.com/a_b">https://example.com/a_b</a>',
      '<img src="img/a.png" alt="a *pic* [1]">',
    ]);
  });

  test("keeps a code span's edge spaces and backticks through a GFM reader", () => {
    const values = [" x ", "  x  ", " x", "x ", "   ", " ", "`x`", " `x` ", "` `", " a``b ", "``", " | "];
    expect(readBack(oneRow(values.map((value) => [{ type: "code", value }])))).toEqual(values.map((value) => `<code>${shown(value)}</code>`));
  });
});
