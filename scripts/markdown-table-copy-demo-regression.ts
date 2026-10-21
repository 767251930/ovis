import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { demoFilePreviewScript } from "./demo-file-preview.ts";
import { chromePath } from "./chrome-path.ts";

// A completed Markdown table's copy, on the unmodified app over the demo's fixture transport: the
// pi pane's settled answer holds the README's environment table (site/demo/fixtures.ts), and a
// file Preview (the demo has no files, so one is answered here) holds tables at the top, in a
// list item, with no rows, and with a cell no line break fits. The copy is read from the owned
// browser's clipboard and parsed back; a table still arriving offers no copy until the turn
// settles, a refused clipboard says so without a false Copied, and the native selection still
// copies what the browser selected. Each scene runs at 1440 and on a 390 iPhone, light and dark,
// and the new strings once more in Korean on the phone. Screenshots and a manifest go to
// UI_EVIDENCE_DIR or else evidence/. All files and HTTP traffic stay in this disposable,
// loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-markdown-table-copy-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR || join(repo, "evidence");
const PANE = panes.cli;
const FILE = "TABLES.md";
/** the demo's answer is held until the live turn has been checked and seen; released, it settles the turn */
const ANSWER_MS = 15_000;

const ENV_TABLE = [
  "| Variable | Default | Overrides | Notes |",
  "| --- | --- | --- | --- |",
  "| `RELEASE_RETRIES` | `3` | `--retries` | transport failures only; a 4xx fails on the first answer |",
  "| `RELEASE_REGISTRY` | `https://registry.example.com` | `--registry` | see [the registry notes](https://example.com/docs/registry) |",
  "| `RELEASE_DRY_RUN` | unset | `--dry-run` | prints the upload without sending it |",
].join("\n");
const LANGUAGE_ROW = "| `RELEASE_LANGUAGE` | `ko` | `--language` | 한국어 안내문은 `docs/ko/README.md`를 봅니다 |";
/** what the pi pane answers to ASK, as the demo's answer arrives: cut inside a row, then whole */
const ASK = "Show the environment table with the language row";
const PARTIAL_ANSWER = `Here it is, with the language row:\n\n${ENV_TABLE.split("\n").slice(0, 4).join("\n")}\n| \`RELEASE_DRY_RUN\` | unset | \`--dry-r`;
/** text the app shows as written: tags, an entity and a trailing backslash a GFM reader must not read as markup */
const LITERAL_ROW = "| `RELEASE_NOTE` | <b>literal</b> &copy; | `--note` | C:\\temp\\ |";
const WHOLE_TABLE = `${ENV_TABLE}\n${LANGUAGE_ROW}\n${LITERAL_ROW}`;
/** WHOLE_TABLE as copied: the literal row's markup characters escaped, so a GFM reader shows them as text */
const WHOLE_COPY = `${ENV_TABLE}\n${LANGUAGE_ROW}\n| \`RELEASE_NOTE\` | \\<b>literal\\</b> \\&copy; | \`--note\` | C:\\\\temp\\\\ |`;
const WHOLE_ANSWER = `Here it is, with the language row:\n\n${WHOLE_TABLE}\n\nSet them in the shell that runs \`release publish\`.`;
const LONG_CELL = `ghp_${"x".repeat(96)}`;
const FILE_TEXT = [
  "# Release settings",
  "",
  "The variables below set the defaults; a flag on the command line still wins.",
  "",
  WHOLE_TABLE,
  "",
  "## Steps",
  "",
  "1. Read the table above.",
  "   - Then the steps:",
  "",
  "     | Step | Command |",
  "     | --- | --- |",
  "     | build | `bun run build` |",
  "     | test | `bun test` |",
  "",
  "2. Done.",
  "",
  "## Empty",
  "",
  "| Column A | Column B |",
  "| --- | --- |",
  "",
  "## Long cells",
  "",
  "| Key | Value |",
  "| --- | --- |",
  `| token | ${LONG_CELL} |`,
  "",
  ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} of the notes, long enough that the Preview scrolls.\n`),
  "The end of the file.",
].join("\n");
const NESTED_TABLE = "| Step | Command |\n| --- | --- |\n| build | `bun run build` |\n| test | `bun test` |";
const EMPTY_TABLE = "| Column A | Column B |\n| --- | --- |";
const LONG_TABLE = `| Key | Value |\n| --- | --- |\n| token | ${LONG_CELL} |`;

/** The pi pane's conversation as the demo answers it, with ASK's answer put in: a live turn cut mid-row until the demo's answer settles it. */
const CONVERSATION_SCRIPT = `<script>(${((pane: string, ask: string, partial: string, whole: string) => {
  const demoFetch = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const response = await demoFetch(input, init);
    if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== pane) return response;
    const body = await response.json() as { turns: { role: string; ts: string | null; end_ts?: string; parts: { kind: string; text?: string; phase?: string }[] }[] };
    const last = body.turns[body.turns.length - 1];
    const asked = body.turns.some((turn) => turn.role === "user" && turn.parts[0]?.text === ask);
    if (asked && last?.role === "user") body.turns.push({ role: "assistant", ts: last.ts, parts: [{ kind: "text", phase: "final_answer", text: partial }] });
    else if (asked && last?.role === "assistant" && last.parts[0]?.text?.startsWith("This is the demo")) last.parts = [{ kind: "text", phase: "final_answer", text: whole }];
    return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
  }, { preconnect: demoFetch.preconnect });
}).toString()})(${JSON.stringify(PANE)}, ${JSON.stringify(ASK)}, ${JSON.stringify(PARTIAL_ANSWER)}, ${JSON.stringify(WHOLE_ANSWER)});</script>`;

/** The file's bytes wait for window.__releaseFile() while window.__holdFile is set: the Preview's loading state can be seen. */
const HOLD_SCRIPT = `<script>(() => {
  const fixtureFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (window.__holdFile && url.pathname.endsWith("/fs/file")) await new Promise((release) => { window.__releaseFile = release; });
    return fixtureFetch(input, init);
  };
})();</script>`;

/**
 * While window.__holdAnswer is set, the demo's answer to a sent message (its CHAT_ANSWER_MS timer in
 * site/demo/transport.ts) waits for window.__releaseAnswer(): the live turn is checked and seen
 * before it can settle, whatever the machine's speed.
 */
const ANSWER_HOLD_SCRIPT = `<script>(() => {
  const later = window.setTimeout;
  const held = [];
  window.__heldAnswers = () => held.length;
  window.setTimeout = (callback, ms, ...args) => {
    if (window.__holdAnswer && ms === 2400 && typeof callback === "function") { held.push(() => callback(...args)); return 0; }
    return later(callback, ms, ...args);
  };
  window.__releaseAnswer = () => { window.__holdAnswer = false; for (const run of held.splice(0)) run(); };
})();</script>`;

type Theme = "light" | "dark";
interface Shot { file: string; width: number; height: number; theme: Theme; language: string; state: string; sha256: string; capturedAt: string }
const manifest: Shot[] = [];
const qa: Record<string, unknown[]> = { "completed-table-copied": [], "incomplete-denied-clipboard": [] };
const note = (scenario: keyof typeof qa, entry: Record<string, unknown>): void => { qa[scenario]!.push(entry); };

async function capture(page: Page, width: number, theme: Theme, state: string, language = "en", around?: Locator): Promise<void> {
  const file = `table-copy-${width}-${theme}${language === "en" ? "" : `-${language}`}-${state}.png`;
  const path = join(evidence, file);
  await appFaces(page);
  // a close-up: the control and the ring or glyph around it, which an element shot would cut at its box
  const box = around === undefined ? null : await around.boundingBox();
  await page.screenshot({ path, animations: "disabled", ...(box === null ? {} : { clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 } }) });
  const size = await page.viewportSize();
  manifest.push({ file, width: size?.width ?? width, height: size?.height ?? 0, theme, language, state, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), capturedAt: new Date().toISOString() });
}

/** The clipboard's text, read through the API and through a native paste, which must agree. */
async function readClipboard(page: Page): Promise<string> {
  const read = await page.evaluate(() => navigator.clipboard.readText());
  await page.evaluate(() => {
    const input = document.createElement("textarea");
    input.id = "clipboard-reader";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("ControlOrMeta+v");
  const pasted = await page.locator("#clipboard-reader").inputValue();
  await page.locator("#clipboard-reader").evaluate((node) => node.remove());
  assert.equal(pasted, read, "a native paste gives the text the clipboard API read");
  return read;
}

/** A pasted table as a GFM reader shows it: Bun's GFM HTML, read by the page's own parser, as each row's cell text. */
async function gfmRows(page: Page, gfm: string): Promise<string[][]> {
  const html = Bun.markdown.html(gfm, { autolinks: true });
  return page.evaluate((markup) => {
    const tables = new DOMParser().parseFromString(markup, "text/html").querySelectorAll("table");
    if (tables.length !== 1) throw new Error(`a GFM reader found ${tables.length} tables in the copy`);
    return [...tables[0]!.rows].map((row) => [...row.cells].map((cell) => cell.textContent ?? ""));
  }, html);
}

/** The table as the app shows it: each row's cell text. */
const shownRows = (block: Locator): Promise<string[][]> => block.locator("table").evaluate((table: HTMLTableElement) => [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent ?? "")));

/** Tab reaches the button from the element before it, so the ring is the keyboard's (:focus-visible). */
async function focusByKeyboard(page: Page, button: Locator): Promise<void> {
  await button.evaluate((node) => {
    const before = document.createElement("button");
    before.id = "focus-start";
    node.parentElement!.insertBefore(before, node);
    before.focus();
  });
  await page.keyboard.press("Tab");
  await page.locator("#focus-start").evaluate((node) => node.remove());
  assert.equal(await button.evaluate((node) => node === document.activeElement && node.matches(":focus-visible")), true, "Tab lands on the copy with a visible ring");
}

/**
 * A refusal is read at no less than the minimum text size (15 px on a phone, 14 px on a desktop)
 * and starts below the copy's focus ring, so the ring a keyboard leaves on the copy never crosses it.
 */
async function refusalClearOfRing(alert: Locator, button: Locator, width: number): Promise<void> {
  const { size, gap } = await alert.evaluate((node, control) => {
    const root = getComputedStyle(document.documentElement);
    const ring = parseFloat(root.getPropertyValue("--ring")) + parseFloat(root.getPropertyValue("--ring-offset"));
    return { size: parseFloat(getComputedStyle(node).fontSize), gap: node.getBoundingClientRect().top - (control!.getBoundingClientRect().bottom + ring) };
  }, await button.elementHandle());
  assert.ok(size >= (width === 390 ? 15 : 14), `the refusal reads at ${size}px`);
  assert.ok(gap >= 0, `the refusal starts ${-gap}px inside the copy's focus ring`);
}

async function withContext(browser: Browser, width: number, theme: Theme, language: string, run: (page: Page, context: BrowserContext) => Promise<void>, hold?: "file" | "answer"): Promise<void> {
  const phone = width === 390;
  const context = await browser.newContext({
    ...(phone ? { ...devices["iPhone 14"]!, viewport: { width: 390, height: 844 } } : { viewport: { width, height: 900 } }),
    colorScheme: theme, locale: language === "ko" ? "ko-KR" : "en-US", permissions: ["clipboard-read", "clipboard-write"],
  });
  try {
    await context.addInitScript(([settings, pane, held]) => {
      localStorage.setItem("herdr-web-ui:settings", settings);
      localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
      if (held === "file") (window as unknown as { __holdFile: boolean }).__holdFile = true;
      if (held === "answer") (window as unknown as { __holdAnswer: boolean }).__holdAnswer = true;
    }, [JSON.stringify({ language, theme, fileOpen: "panel" }), PANE, hold] as const);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await run(page, context);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${demoFilePreviewScript(FILE, FILE_TEXT)}${CONVERSATION_SCRIPT}${HOLD_SCRIPT}${ANSWER_HOLD_SCRIPT}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = (search: string): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}&view=chat${search}`;
  mkdirSync(evidence, { recursive: true });

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const chatLog = async (page: Page): Promise<Locator> => {
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const stack = page.locator(`.terminal-stack.is-chat[data-pane-owner="${PANE}"]`);
        await stack.waitFor();
        return stack.getByRole("log");
      };
      /** the settled answer's table block: the turn with the environment table, before any message is sent */
      const settledTable = (log: Locator): Locator => log.locator(".chat-turn-agent").filter({ hasText: "RELEASE_DRY_RUN" }).first().locator(".markdown-table").first();

      for (const width of [1440, 390] as const) {
        for (const theme of ["light", "dark"] as const) {
          const label = `${width} ${theme}`;
          const phone = width === 390;

          // the settled answer: its table has its copy, which copies the whole table as GFM
          await withContext(browser, width, theme, "en", async (page, context) => {
            await page.goto(url(""));
            const log = await chatLog(page);
            const block = settledTable(log);
            const button = block.locator(".markdown-table-copy");
            await button.waitFor({ state: "attached" });
            assert.equal(await button.getAttribute("aria-label"), "Copy table");
            await block.scrollIntoViewIfNeeded();
            await capture(page, width, theme, "rest");
            const box = (await button.boundingBox())!;
            if (phone) assert.ok(box.width >= 44 && box.height >= 44, `a finger's target: ${JSON.stringify(box)}`);
            else {
              assert.equal(await button.evaluate((node) => getComputedStyle(node).opacity), "0", "with a mouse the copy waits for a hover");
              await block.hover();
              await page.waitForFunction((node) => getComputedStyle(node).opacity === "1", await block.elementHandle());
              await capture(page, width, theme, "hover");
            }
            await focusByKeyboard(page, button);
            await capture(page, width, theme, "focus-visible");
            await capture(page, width, theme, "focus-visible-closeup", "en", button);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await capture(page, width, theme, "pressed");
            await page.mouse.up();
            await block.locator(".markdown-table-copy.is-copied").waitFor();
            assert.equal(await button.getAttribute("aria-label"), "Table copied");
            await capture(page, width, theme, "copied");
            const copied = await readClipboard(page);
            assert.equal(copied, ENV_TABLE, "the settled table is copied whole, as GFM");
            const cells = await gfmRows(page, copied);
            assert.deepEqual(cells, await shownRows(block), "a GFM reader shows the copy as the app showed the table");
            assert.deepEqual(cells[0], ["Variable", "Default", "Overrides", "Notes"]);
            assert.equal(cells.length, 4, "a header and three rows");
            assert.ok(cells.every((row) => row.length === 4), "every row has the header's width");
            assert.ok(Bun.markdown.html(copied, { autolinks: true }).includes("<td><code>RELEASE_REGISTRY</code></td>"), "a code span reads back as code");
            assert.ok(Bun.markdown.html(copied, { autolinks: true }).includes('<a href="https://example.com/docs/registry">the registry notes</a>'), "a link keeps its label and address");
            note("completed-table-copied", { surface: "chat", width, theme, copied, cells });
            await button.evaluate((node) => (node as HTMLElement).blur());
            await page.waitForFunction((node) => node.getAttribute("aria-label") === "Copy table", await button.elementHandle(), { timeout: 5_000 });

            // the table scrolls sideways in its own box, never the page, and the copy stays in reach
            const scrolled = await block.evaluate((node) => {
              const wrap = node.querySelector<HTMLElement>(".markdown-table-wrap")!;
              wrap.scrollLeft = wrap.scrollWidth;
              const control = node.querySelector<HTMLElement>(".markdown-table-copy")!;
              const copy = control.getBoundingClientRect();
              const view = node.closest<HTMLElement>(".chat-view")!;
              const hit = document.elementFromPoint(copy.left + copy.width / 2, copy.top + copy.height / 2);
              return {
                overflow: wrap.scrollWidth > wrap.clientWidth, scrollLeft: wrap.scrollLeft,
                page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, chat: view.scrollWidth <= view.clientWidth,
                reachable: hit !== null && (hit === control || control.contains(hit)), inView: copy.left >= 0 && copy.right <= window.innerWidth,
              };
            });
            if (phone) assert.equal(scrolled.overflow, true, "on a phone the table is wider than its box");
            assert.ok(scrolled.page && scrolled.chat, `the page and the chat never scroll sideways: ${JSON.stringify(scrolled)}`);
            assert.ok(scrolled.reachable && scrolled.inView, `the copy stays in reach at the end of the table's scroll: ${JSON.stringify(scrolled)}`);
            await capture(page, width, theme, "hscroll-end");
            note("completed-table-copied", { surface: "chat", width, theme, horizontalScroll: scrolled });

            // offline, the content already shown keeps its copy: nothing is asked of the server
            await context.setOffline(true);
            await button.click({ force: true });
            await block.locator(".markdown-table-copy.is-copied").waitFor();
            assert.equal(await readClipboard(page), ENV_TABLE, "offline, a loaded table still copies");
            await capture(page, width, theme, "offline");
            await context.setOffline(false);
            console.log(`PASS ${label}: the settled answer's table copies whole as GFM, from the end of its sideways scroll and offline`);
          });

          // a table still arriving has no copy; the demo's answer settles the turn and the copy appears
          await withContext(browser, width, theme, "en", async (page) => {
            await page.goto(url(""));
            const log = await chatLog(page);
            await settledTable(log).locator(".markdown-table-copy").waitFor({ state: "attached" });
            await page.getByRole("textbox", { name: "Message", exact: true }).fill(ASK);
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            // the demo's answer is held: nothing settles this turn until it is released below
            await page.waitForFunction(() => (window as unknown as { __heldAnswers: () => number }).__heldAnswers() === 1);
            const turn = log.locator(".chat-turn-agent").last();
            const live = turn.locator(".markdown-table").filter({ hasText: "RELEASE_REGISTRY" });
            await live.locator("td", { hasText: "--dry-r" }).waitFor();
            assert.equal(await live.locator(".markdown-table-copy").count(), 0, "a table cut mid-row offers no copy");
            assert.equal(await live.locator(".markdown-table-header").count(), 1, "its action row holds its place");
            const placeOf = (node: Element): number => node.getBoundingClientRect().top - node.closest(".chat-turn")!.getBoundingClientRect().top;
            const livePlace = await live.evaluate(placeOf);
            await capture(page, width, theme, "live-hidden");
            note("incomplete-denied-clipboard", { surface: "chat", width, theme, streaming: { copies: 0, rows: await live.locator("tbody tr").count() } });
            assert.equal(await live.locator(".markdown-table-copy").count(), 0, "still no copy once seen: the answer is still held");
            await page.evaluate(() => (window as unknown as { __releaseAnswer: () => void }).__releaseAnswer());
            await turn.locator("td", { hasText: "RELEASE_LANGUAGE" }).waitFor({ timeout: ANSWER_MS });
            const settled = turn.locator(".markdown-table").filter({ hasText: "RELEASE_LANGUAGE" });
            const button = settled.locator(".markdown-table-copy");
            await button.waitFor({ state: "attached" });
            assert.equal(await settled.evaluate(placeOf), livePlace, "the table stays where it was in its turn when its copy arrives");
            await settled.scrollIntoViewIfNeeded();
            await button.click({ force: true });
            await settled.locator(".markdown-table-copy.is-copied").waitFor();
            const copied = await readClipboard(page);
            assert.equal(copied, WHOLE_COPY, "the settled answer copies its whole table, Korean and all, its literal row escaped");
            const cells = await gfmRows(page, copied);
            assert.deepEqual(cells, await shownRows(settled), "a GFM reader shows the copy as the app showed the table");
            assert.deepEqual(cells[5], ["RELEASE_NOTE", "<b>literal</b> &copy;", "--note", "C:\\temp\\"], "tags, an entity and a trailing backslash read back as shown");
            assert.equal(cells[4]![3], "한국어 안내문은 `docs/ko/README.md`를 봅니다".replaceAll("`", ""), "the Korean row reads back as shown");
            note("completed-table-copied", { surface: "chat after streaming", width, theme, copied });
            await page.waitForFunction((node) => node.getAttribute("aria-label") === "Copy table", await button.elementHandle(), { timeout: 5_000 });

            // the clipboard refuses: the row says so, nothing says Copied, and the native selection still copies
            await page.evaluate(() => {
              navigator.clipboard.writeText = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
              document.execCommand = () => false;
            });
            await button.click({ force: true });
            const alert = settled.locator(".markdown-table-error[role=alert]");
            await alert.waitFor();
            assert.equal(await alert.textContent(), "Couldn't copy. Select the text and copy it manually.");
            assert.equal(await button.getAttribute("aria-label"), "Copy table", "a refused copy never says Copied");
            assert.equal(await settled.locator(".is-copied").count(), 0);
            await refusalClearOfRing(alert, button, width);
            await capture(page, width, theme, "error");
            await page.evaluate(() => {
              delete (navigator.clipboard as { writeText?: unknown }).writeText;
              delete (document as { execCommand?: unknown }).execCommand;
            });
            const selected = await settled.locator("table").evaluate((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              getSelection()!.removeAllRanges();
              getSelection()!.addRange(range);
              return getSelection()!.toString();
            });
            await page.keyboard.press("ControlOrMeta+c");
            const native = await readClipboard(page);
            assert.equal(native, selected, "a selection across the table copies what the browser selected");
            assert.ok(!native.includes("| ---"), "the selection is not turned into GFM");
            const rich = await page.evaluate(async () => (await (await navigator.clipboard.read())[0]!.getType("text/html")).text());
            assert.ok(rich.includes("<table>") && !rich.includes("markdown-table-copy") && !rich.includes("<button"), `the rich copy carries the table without its control: ${rich.slice(0, 200)}`);
            note("incomplete-denied-clipboard", { surface: "chat", width, theme, denied: { alert: await alert.textContent(), label: await button.getAttribute("aria-label") }, nativeSelection: { text: native, richHasTable: rich.includes("<table>") } });
            await page.evaluate(() => getSelection()!.removeAllRanges());
            console.log(`PASS ${label}: a streaming table hides its copy until the turn settles, a refused clipboard says so without Copied, and the selection still copies natively`);
          }, "answer");

          // the file Preview: every table has its copy, nested or empty, and the long cell keeps its column
          await withContext(browser, width, theme, "en", async (page) => {
            await page.goto(url(`&file=${FILE}`));
            await page.locator(".conn-live").waitFor({ state: "attached" });
            const viewer = page.locator(".file-viewer");
            await viewer.waitFor();
            const body = viewer.locator(".file-viewer-body");
            const tables = viewer.locator(".markdown-table");
            await tables.nth(3).waitFor();
            assert.equal(await tables.count(), 4);
            assert.equal(await viewer.locator(".markdown-table-copy").count(), 4, "every table of a complete Preview has its copy, in a list item and with no rows too");
            const nested = viewer.locator("li .markdown-table").first();
            await nested.scrollIntoViewIfNeeded();
            await capture(page, width, theme, "preview-rest");
            await nested.locator(".markdown-table-copy").click({ force: true });
            await nested.locator(".is-copied").waitFor();
            const copiedNested = await readClipboard(page);
            assert.equal(copiedNested, NESTED_TABLE, "a table nested in a list item copies as itself");
            await capture(page, width, theme, "preview-nested-copied");
            const top = tables.first();
            await top.locator(".markdown-table-copy").click({ force: true });
            await top.locator(".is-copied").waitFor();
            const copiedTop = await readClipboard(page);
            assert.equal(copiedTop, WHOLE_COPY, "the Preview's first table copies whole, Korean and all, its literal row escaped");
            assert.deepEqual(await gfmRows(page, copiedTop), await shownRows(top), "a GFM reader shows the Preview's copy as the Preview showed it");
            const empty = viewer.locator(".markdown-table").filter({ hasText: "Column A" });
            await empty.scrollIntoViewIfNeeded();
            await empty.locator(".markdown-table-copy").click({ force: true });
            await empty.locator(".is-copied").waitFor();
            assert.equal(await readClipboard(page), EMPTY_TABLE, "a table with no rows copies its header and separator");
            await capture(page, width, theme, "preview-empty");
            const long = viewer.locator(".markdown-table").filter({ hasText: "token" });
            await long.scrollIntoViewIfNeeded();
            await long.locator(".markdown-table-copy").click({ force: true });
            await long.locator(".is-copied").waitFor();
            assert.equal(await readClipboard(page), LONG_TABLE, "a cell no line break fits copies within its column");
            const longBox = await long.evaluate((node) => {
              const wrap = node.querySelector<HTMLElement>(".markdown-table-wrap")!;
              return { overflow: wrap.scrollWidth > wrap.clientWidth, page: document.documentElement.scrollWidth <= document.documentElement.clientWidth, body: node.closest<HTMLElement>(".file-viewer-body")!.scrollWidth <= node.closest<HTMLElement>(".file-viewer-body")!.clientWidth };
            });
            assert.ok(longBox.page && longBox.body, `the long cell scrolls in its own box, never the viewer: ${JSON.stringify(longBox)}`);
            await capture(page, width, theme, "preview-long-cells");
            note("completed-table-copied", { surface: "file Preview", width, theme, tables: await tables.count(), nested: copiedNested, empty: EMPTY_TABLE, long: longBox });
            await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
            await page.getByText("The end of the file.", { exact: true }).waitFor();
            await capture(page, width, theme, "preview-end");
            console.log(`PASS ${label}: the file Preview's tables copy as GFM, nested, empty and with a long cell`);
          });

          // the Preview while its file is still on its way: nothing to copy yet (the phone's dialog says
          // Opening…; the docked panel waits with an empty body)
          await withContext(browser, width, theme, "en", async (page) => {
            await page.goto(url(`&file=${FILE}`));
            await page.locator(".file-viewer").waitFor();
            if (phone) await page.locator(".file-viewer-note[role=status]", { hasText: "Opening…" }).waitFor();
            assert.equal(await page.locator(".file-viewer .markdown, .file-viewer .markdown-table-copy").count(), 0, "nothing is drawn, so nothing is offered, until the file is in");
            await capture(page, width, theme, "preview-loading");
            await page.evaluate(() => (window as unknown as { __releaseFile: () => void }).__releaseFile());
            await page.locator(".file-viewer .markdown-table-copy").first().waitFor({ state: "attached" });
            console.log(`PASS ${label}: a Preview still opening offers no copy, and the file's tables do once it is in`);
          }, "file");
        }
      }

      // the new strings in Korean, on the phone: the copy's name and the refusal
      await withContext(browser, 390, "light", "ko", async (page) => {
        await page.goto(url(""));
        const log = await chatLog(page);
        const block = settledTable(log);
        const button = block.locator(".markdown-table-copy");
        await button.waitFor({ state: "attached" });
        assert.equal(await button.getAttribute("aria-label"), "표 복사");
        await block.scrollIntoViewIfNeeded();
        await capture(page, 390, "light", "rest", "ko");
        await button.click({ force: true });
        await block.locator(".is-copied").waitFor();
        assert.equal(await button.getAttribute("aria-label"), "표 복사됨");
        await capture(page, 390, "light", "copied", "ko");
        await page.waitForFunction((node) => node.getAttribute("aria-label") === "표 복사", await button.elementHandle(), { timeout: 5_000 });
        await page.evaluate(() => {
          navigator.clipboard.writeText = () => Promise.reject(new DOMException("Denied", "NotAllowedError"));
          document.execCommand = () => false;
        });
        await button.click({ force: true });
        const alert = block.locator(".markdown-table-error[role=alert]");
        await alert.waitFor();
        assert.equal(await alert.textContent(), "복사하지 못했습니다. 텍스트를 선택해 직접 복사하세요.");
        await refusalClearOfRing(alert, button, 390);
        await capture(page, 390, "light", "error", "ko");
        console.log("PASS 390 ko: the copy's name and the refusal read in Korean");
      });
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
  writeFileSync(join(evidence, "table-copy-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [scenario, entries] of Object.entries(qa)) writeFileSync(join(evidence, `table-copy-${scenario}.json`), `${JSON.stringify({ scenario, result: "PASS", entries }, null, 2)}\n`);
  console.log(`PASS ${manifest.length} captures and the clipboard records are in ${evidence}`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
