/** Rendered selection -> native plain text and resource-free rich HTML.
 * HTML sanitization adapted from t3code's markdown-clipboard.ts (MIT).
 */
import type { InlineNode, MarkdownBlock } from "./markdown.ts";

export interface ClipboardNode {
  readonly tag: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly ClipboardNode[];
}

export interface ClipboardPayload {
  readonly text: string;
  readonly html: string;
}

const OMIT = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);
const HTML_TAGS = new Set(["P", "BR", "HR", "PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S", "A", "UL", "OL", "LI", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "H1", "H2", "H3", "H4", "H5", "H6"]);
const OMIT_CLASSES = new Set(["markdown-code-header", "markdown-code-error", "hl-note", "chat-turn-meta", "chat-meta", "sr-only"]);
const attr = (node: ClipboardNode, name: string): string | undefined => node.attrs?.[name];
const children = (node: ClipboardNode): readonly ClipboardNode[] => node.children ?? [];
const visible = (node: ClipboardNode): boolean => (!OMIT.has(node.tag) || (node.tag === "BUTTON" && (attr(node, "class") ?? "").split(/\s+/).includes("markdown-file"))) && attr(node, "aria-hidden") !== "true" && !(attr(node, "class") ?? "").split(/\s+/).some((name) => OMIT_CLASSES.has(name));
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Rebuild, rather than scrub arbitrary HTML: attributes cannot smuggle resources or handlers. */
function richHtml(node: ClipboardNode): string {
  if (!visible(node)) return "";
  if (node.text !== undefined) return escapeHtml(node.text);
  if (node.tag === "IMG") return escapeHtml(attr(node, "alt") ?? "");
  const content = children(node).map(richHtml).join("");
  if (!HTML_TAGS.has(node.tag)) return content;
  const tag = node.tag.toLowerCase();
  let attributes = "";
  const href = attr(node, "href");
  if (node.tag === "A" && href && /^(https?:\/\/|mailto:)/i.test(href)) attributes = ` href="${escapeHtml(href)}"`;
  const start = attr(node, "start");
  if (node.tag === "OL" && start && /^\d+$/.test(start)) attributes = ` start="${start}"`;
  return node.tag === "BR" || node.tag === "HR" ? `<${tag}>` : `<${tag}${attributes}>${content}</${tag}>`;
}

/** The browser owns plain-text layout and whitespace; only the rich representation is rebuilt. */
export function renderedClipboardPayload(nodes: readonly ClipboardNode[], text: string): ClipboardPayload {
  return { text, html: nodes.map(richHtml).join("") };
}

/** A table block as the parser reads it (lib/markdown.ts): the header's cells and each row's. */
export type MarkdownTable = Extract<MarkdownBlock, { type: "table" }>;

/**
 * What a GFM cell cannot hold unescaped: a pipe ends the cell, a backslash would escape the next
 * character. Inside a link's label a bracket would end the label too.
 */
const escapeText = (value: string, label: boolean): string => value.replace(label ? /[\\|[\]]/g : /[\\|]/g, "\\$&");
/**
 * A destination holds no whitespace, and a parenthesis, pipe or backslash in one would end it or
 * the cell: percent-encoded, the address still names the same resource, and it reads back as one.
 */
const escapeDestination = (value: string): string => value.replace(/[\s()|\\]/g, (char) => (/\s/.test(char) ? encodeURIComponent(char) : `%${char.charCodeAt(0).toString(16).toUpperCase()}`));

/**
 * A code span whose delimiter is longer than any run of backticks inside it, padded with a space
 * when the code starts or ends with a backtick (CommonMark strips one space from each end). A pipe
 * inside is still escaped: GFM reads the cell's pipes before its spans. A backslash is not: a code
 * span is literal.
 */
function codeSpan(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value.replace(/\|/g, "\\|")}${pad}${fence}`;
}

/** A link or file whose label is its own address: written bare, as the writer had it, and read as a link again. */
const bare = (node: Extract<InlineNode, { type: "link" | "file" }>): string | null => {
  const [only] = node.children;
  if (node.children.length !== 1 || only?.type !== "text") return null;
  return only.value === (node.type === "link" ? node.href : `file://${node.path}`) ? only.value : null;
};

/**
 * The GFM source of a cell's inline nodes, on one line: a line break inside a cell is `<br>`.
 * Emphasis is written with `*`, which reads inside a word too; a formula keeps its backslashes,
 * which are its commands, and only its pipes are escaped.
 */
function inlineSource(nodes: readonly InlineNode[], label = false): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": out += escapeText(node.value, label); break;
      case "code": out += codeSpan(node.value); break;
      case "math": out += `\\(${node.value.replace(/\|/g, "\\|")}\\)`; break;
      case "strong": out += `**${inlineSource(node.children, label)}**`; break;
      case "em": out += `*${inlineSource(node.children, label)}*`; break;
      case "del": out += `~~${inlineSource(node.children, label)}~~`; break;
      case "link":
      case "file": {
        const address = bare(node);
        out += address !== null ? escapeText(address, label) : `[${inlineSource(node.children, true)}](${escapeDestination(node.type === "link" ? node.href : node.path)})`;
        break;
      }
      case "image": out += `![${escapeText(node.alt, true)}](${escapeDestination(node.src)})`; break;
    }
  }
  return out.replace(/\r\n|[\n\r\u2028\u2029]/g, "<br>");
}

/**
 * A table as GFM: the header, a `---` separator per column and every row padded or cut to the
 * header's width, so the result parses as one rectangular table wherever it is pasted. Cells are
 * written from the parsed nodes, not the source: alignment the parser does not keep is not
 * promised, and a cell's pipes and backslashes come out escaped.
 */
export function serializeMarkdownTable(table: MarkdownTable): string {
  const width = Math.max(1, table.header.length);
  const row = (cells: readonly (readonly InlineNode[])[]): string =>
    `| ${Array.from({ length: width }, (_, index) => inlineSource(cells[index] ?? [])).join(" | ")} |`;
  return [row(table.header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...table.rows.map(row)].join("\n");
}

function fromDom(node: Node): ClipboardNode {
  if (!(node instanceof Element)) return { tag: "", text: node.nodeType === 3 ? node.textContent ?? "" : "", children: [...node.childNodes].map(fromDom) };
  const attrs = Object.fromEntries([...node.attributes].map((entry) => [entry.name, entry.value]));
  return { tag: node.tagName, attrs, children: [...node.childNodes].map(fromDom) };
}

/** Only claim ranges wholly in this chat; composer fields and the terminal keep native copy. */
export function chatSelectionClipboardPayload(selection: Selection, root: Element): ClipboardPayload | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const nodes: ClipboardNode[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const ancestor = range.commonAncestorContainer;
    const element = ancestor instanceof Element ? ancestor : ancestor.parentElement;
    if (element?.closest("input, textarea, [contenteditable=true]")) return null;
    const container = document.createElement("div");
    container.append(range.cloneContents());
    // cloneContents drops the common ancestor and all its formatting. Restore those wrappers
    // only up to Markdown, never a virtual row or the scroller itself.
    let wrapped: Node = container;
    if (element?.closest(".markdown")) {
      for (let current: Element | null = element; current && !current.classList.contains("markdown"); current = current.parentElement) {
        const wrapper = current.cloneNode(false);
        while (wrapped.firstChild) wrapper.appendChild(wrapped.firstChild);
        const parent = document.createElement("div");
        parent.appendChild(wrapper);
        wrapped = parent;
      }
    }
    nodes.push(...[...wrapped.childNodes].map(fromDom));
  }
  const text = selection.toString();
  // An image-only range can have no plain text; still intercept it so native copy cannot
  // bypass the resource-free HTML representation.
  return renderedClipboardPayload(nodes, text);
}
