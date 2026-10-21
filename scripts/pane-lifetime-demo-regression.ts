import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { paneStateStorageId } from "../shared/machines.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A pane's unsent text and lens belong to the pane in its herdr lifetime (src/lib/paneState.ts), on
// the unmodified app over the demo's fixture transport: a bridge restart (a new finish epoch) keeps
// them, a herdr that replaced the last one and reuses its pane IDs starts them empty, and earlier
// text comes back only through Recover unsent text, into the box the user picks, never sent. This
// page script rewrites the lifetime every snapshot carries, adds a second PC with the same pane IDs,
// holds acknowledgements and records every frame the page sends. Nothing leaves this disposable,
// loopback-only app; no herdr session is opened. UI_EVIDENCE_DIR: the capture set, PANE_LIFETIME_EVIDENCE:
// each scenario's checks as JSON.
const app = mkdtempSync(join(tmpdir(), "herdr-pane-lifetime-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const results = process.env.PANE_LIFETIME_EVIDENCE;

const playwrightCore = "playwright-core";
const { chromium, devices } = (await import(playwrightCore)) as typeof import("playwright-core");

const A = "demo-herdr-local";
const B = "demo-herdr-local-replaced";
const AGENT = panes.api;
const SHELL = panes.shell;
const OTHER = panes.cli;
const owner = (pane: string, lifetime: string, machine = "local"): string => paneStateStorageId(machine, pane, lifetime);
const draftKey = (pane: string, lifetime: string, machine = "local"): string => `herdr-web-ui:composer-draft:${owner(pane, lifetime, machine)}`;
const lineKey = (pane: string, lifetime: string, machine = "local"): string => `herdr-web-ui:terminal-line:${owner(pane, lifetime, machine)}`;
const heldKey = (pane: string, lifetime: string, machine = "local"): string => `herdr-web-ui:terminal-draft:${owner(pane, lifetime, machine)}`;
const lensKey = (pane: string, lifetime: string, machine = "local"): string => `herdr-web-ui:view:${owner(pane, lifetime, machine)}`;

type Check = { name: string; detail?: unknown };
const scenarios: Record<string, Check[]> = { "restart-isolates-and-recovers": [], "ambiguous-and-late-drafts": [] };
const pass = (scenario: string, name: string, detail?: unknown): void => {
  scenarios[scenario]!.push(detail === undefined ? { name } : { name, detail });
  console.log(`PASS ${name}`);
};

/**
 * Over the demo: `window.lifetimes` names each PC's lifetime in every snapshot (null: none, as an
 * older bridge); `window.laptop` adds a PC "laptop" with the same pane IDs; `window.holdAcks` keeps
 * submit-result frames until `window.releaseAcks()`; `window.sentFrames` lists every frame sent.
 */
const control = `<script>(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource, DemoSocket = window.WebSocket;
  window.lifetimes = {};
  window.laptop = JSON.parse(sessionStorage.getItem("pane-lifetime-test:laptop") ?? "null");
  // a pane whose agent status this check holds still, over the demo's own turns
  const pinned = JSON.parse(sessionStorage.getItem("pane-lifetime-test:pinned") ?? "{}");
  const pin = (snapshot) => {
    for (const pane of snapshot.panes ?? []) if (pinned[pane.pane_id]) pane.agent_status = pinned[pane.pane_id];
    for (const agent of snapshot.agents ?? []) if (pinned[agent.pane_id]) agent.agent_status = pinned[agent.pane_id];
    return snapshot;
  };
  const pinFrame = (message) => message && message.type === "pane-status" && pinned[message.pane_id] ? { ...message, agent_status: pinned[message.pane_id] } : message;
  window.emptyRoster = false;
  window.holdAcks = false;
  window.sentFrames = [];
  const held = [];
  const sockets = new Set();
  const sources = new Set();
  let last = null;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const named = (snapshot, id) => {
    if (!snapshot) return snapshot;
    const copy = structuredClone(snapshot);
    if (window.emptyRoster && id === "local") { copy.panes = []; copy.agents = []; }
    const lifetime = window.lifetimes[id];
    if (lifetime === null) delete copy.herdr_lifetime;
    else if (typeof lifetime === "string") copy.herdr_lifetime = lifetime;
    return pin(copy);
  };
  const roster = (list) => {
    const out = list.map((machine) => ({ ...machine, snapshot: named(machine.snapshot, machine.id) }));
    if (window.laptop) {
      const local = list.find((machine) => machine.id === "local");
      out.push({ ...structuredClone(local), id: "laptop", kind: "ssh", name: window.laptop.name, state: window.laptop.state,
        snapshot: named({ ...structuredClone(local.snapshot), herdr_lifetime: "demo-herdr-laptop" }, "laptop") });
    }
    return out;
  };
  window.emitRoster = () => {
    if (!last) return;
    for (const source of sources) source.deliver({ type: "machines", machines: roster(last) });
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        if (message.type === "machine-message") message.message = pinFrame(message.message);
        this.deliver(message);
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    deliver(message) {
      const event = new MessageEvent("message", { data: JSON.stringify(message) });
      this.onmessage?.(event);
      this.dispatchEvent(new MessageEvent("message", { data: event.data }));
    }
    close() { sources.delete(this); this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (path === "/api/session") {
      const value = await (await fetchDemo("/api/session" + url.search, init)).json();
      return json({ snapshot: machine === "laptop" ? named({ ...value.snapshot, herdr_lifetime: "demo-herdr-laptop" }, "laptop") : named(value.snapshot, "local") });
    }
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
  const Socket = function (url, protocols) {
    const socket = new DemoSocket(url, protocols);
    const machine = new URL(url, location.href).searchParams.get("machine_id") ?? "local";
    sockets.add(socket);
    const push = socket.push.bind(socket);
    socket.push = (message) => {
      message = pinFrame(message);
      if (message.type === "snapshot") message = { ...message, snapshot: machine === "laptop" ? named({ ...message.snapshot, herdr_lifetime: "demo-herdr-laptop" }, "laptop") : named(message.snapshot, "local") };
      if (window.holdAcks && message.type === "submit-result") { held.push(() => push(message)); return; }
      push(message);
    };
    const send = socket.send.bind(socket);
    socket.send = (data) => { try { window.sentFrames.push(JSON.parse(data)); } catch {} return send(data); };
    return socket;
  };
  Socket.prototype = DemoSocket.prototype;
  Object.setPrototypeOf(Socket, DemoSocket);
  window.WebSocket = Socket;
  window.heldAcks = () => held.length;
  window.releaseAcks = () => { window.holdAcks = false; while (held.length) held.shift()(); };
  window.forceObserve = () => { for (const socket of sockets) socket.push({ type: "role-ack", mode: "observe" }); };
})();</script>`;

/** Frames that would reach a pane: input, keys, a submit. */
const INPUT_FRAMES = new Set(["input", "keys", "submit", "secret", "pending-action"]);
const inputFrames = (page: Page): Promise<number> => page.evaluate((types) => (window as unknown as { sentFrames: { type: string }[] }).sentFrames.filter((frame) => types.includes(frame.type)).length, [...INPUT_FRAMES]);
const storageKeys = (page: Page): Promise<string[]> => page.evaluate(() => Object.keys(localStorage).sort());
const stored = (page: Page, key: string): Promise<string | null> => page.evaluate((name) => localStorage.getItem(name), key);
const composer = (page: Page) => page.getByRole("textbox", { name: "Message", exact: true });
const line = (page: Page) => page.getByRole("textbox", { name: "Terminal input line", exact: true });
const valueIs = (page: Page, selector: string, expected: string): Promise<unknown> => page.waitForFunction(([css, value]) =>
  document.querySelector<HTMLTextAreaElement>(css)?.value === value, [selector, expected] as const, { timeout: 10_000 });
const lensIs = (page: Page, lens: "chat" | "terminal"): Promise<unknown> => page.waitForFunction((title) =>
  document.querySelector(".view-switch button[aria-pressed='true'], button[aria-pressed='true'][title^='Chat transcript'], button[aria-pressed='true'][title^='Live terminal']")?.getAttribute("title")?.startsWith(title) === true,
lens === "chat" ? "Chat transcript" : "Live terminal", { timeout: 10_000 });

async function openPane(page: Page, base: string, pane: string): Promise<void> {
  await page.goto(`${base}?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(`.pane-frame[data-layout-pane="${pane}"]`).first().waitFor({ state: "attached" });
}

/** Sets this tab's demo lifetimes (site/demo/transport.ts) and reloads the demo as a new bridge would come up. */
async function restartBridge(page: Page, lifetimes: Record<string, string | null> | null, pane: string, base: string): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) sessionStorage.removeItem("herdr-web-ui-demo:herdr-lifetime");
    else sessionStorage.setItem("herdr-web-ui-demo:herdr-lifetime", JSON.stringify(value));
  }, lifetimes);
  await openPane(page, base, pane);
}

/** The pane's own menu: a right-click on it, as on a desktop (a phone's tab menu holds the same items). */
async function paneMenu(page: Page): Promise<void> {
  const frame = page.locator(".pane-frame").first();
  const rect = (await frame.boundingBox())!;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + 40, { button: "right" });
  await page.getByRole("menu").waitFor();
}
async function openRecovery(page: Page): Promise<void> {
  await paneMenu(page);
  await page.getByRole("menuitem", { name: "Recover unsent text" }).click();
  await page.getByRole("dialog", { name: "Recover unsent text" }).waitFor();
}
const dialog = (page: Page) => page.getByRole("dialog", { name: "Recover unsent text" });
const rows = (page: Page) => dialog(page).locator(".draft-recovery-row");
async function closeRecovery(page: Page): Promise<void> {
  await dialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await dialog(page).waitFor({ state: "detached" });
}

async function newContext(browser: Browser, options: { width: number; phone: boolean; theme: "light" | "dark"; language: "en" | "ko" }): Promise<BrowserContext> {
  const base = options.phone ? { ...devices["iPhone 14"] } : { viewport: { width: options.width, height: 900 }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...base, colorScheme: options.theme, locale: options.language === "ko" ? "ko-KR" : "en-US" });
  await context.addInitScript((settings) => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify(settings));
  }, { language: options.language, theme: options.theme, terminalInputMode: "line" });
  return context;
}

async function happy(browser: Browser, base: string): Promise<void> {
  const S = "restart-isolates-and-recovers";
  const context = await newContext(browser, { width: 1440, phone: false, theme: "dark", language: "en" });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // lifetime A: a message draft, a terminal line and a lens picked by hand
    await openPane(page, base, AGENT);
    await composer(page).fill("A: rename the backup job");
    await valueIs(page, ".composer-text", "A: rename the backup job");
    assert.equal(await stored(page, draftKey(AGENT, A)), "A: rename the backup job");
    await openPane(page, base, SHELL);
    await line(page).fill("A: make deploy");
    await valueIs(page, ".terminal-input-text", "A: make deploy");
    assert.equal(await stored(page, lineKey(SHELL, A)), "A: make deploy");
    await openPane(page, base, panes.web);
    await lensIs(page, "chat");
    await page.locator("button[title^='Live terminal']").first().click();
    await lensIs(page, "terminal");
    assert.equal(await stored(page, lensKey(panes.web, A)), "terminal");
    const epochA = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.finish_epoch as string);
    pass(S, "lifetime A keeps a message draft, a terminal line and a picked lens under its own keys");

    // only the bridge restarts: a new finish epoch, the same herdr, every state stays
    await restartBridge(page, null, AGENT, base);
    const epochAfter = await page.evaluate(async () => (await (await fetch("/api/session")).json()).snapshot.finish_epoch as string);
    assert.notEqual(epochAfter, epochA);
    await valueIs(page, ".composer-text", "A: rename the backup job");
    await openPane(page, base, SHELL);
    await valueIs(page, ".terminal-input-text", "A: make deploy");
    await openPane(page, base, panes.web);
    await lensIs(page, "terminal");
    pass(S, "a bridge restart (new finish epoch, same herdr lifetime) keeps the drafts and the lens", { epochA, epochAfter });

    // herdr is replaced and reuses every pane ID: lifetime B's editors and lenses start fresh
    await restartBridge(page, { local: B }, panes.web, base);
    await lensIs(page, "chat");
    await openPane(page, base, SHELL);
    await valueIs(page, ".terminal-input-text", "");
    await openPane(page, base, AGENT);
    await valueIs(page, ".composer-text", "");
    assert.equal(await stored(page, draftKey(AGENT, A)), "A: rename the backup job", "A's text is still kept");
    assert.equal(await stored(page, lineKey(SHELL, A)), "A: make deploy");
    pass(S, "a replacement herdr with the same pane IDs inherits no draft, line or lens of lifetime A");

    // another of A's records, so a discard can be seen to touch the picked one alone
    await page.evaluate(([key]) => localStorage.setItem(key!, "A: note for the cli pane"), [draftKey(OTHER, A)]);
    const framesBefore = await inputFrames(page);
    await openRecovery(page);
    assert.equal(await composer(page).inputValue(), "", "nothing is filled in by opening recovery");
    const listed = await rows(page).allTextContents();
    assert.ok(listed[0]!.includes("Message draft") && listed[0]!.includes(AGENT), `this pane's record comes first: ${JSON.stringify(listed)}`);
    assert.ok(listed.some((row) => row.includes("Terminal line") && row.includes("A: make deploy")));
    assert.ok(listed.every((row) => row.includes("From an earlier herdr")));
    await rows(page).first().click();
    const recover = dialog(page).getByRole("button", { name: "Recover", exact: true });
    assert.equal(await recover.isDisabled(), true, "Recover waits for a box to be picked");
    await dialog(page).getByRole("radio", { name: "Message box" }).check();
    await recover.click();
    await dialog(page).getByText("Recovered into the message box. Nothing was sent.").waitFor();
    await closeRecovery(page);
    await valueIs(page, ".composer-text", "A: rename the backup job");
    assert.equal(await inputFrames(page), framesBefore, "recovering sends nothing");
    assert.equal(await stored(page, draftKey(AGENT, A)), null, "the recovered record is gone: the box holds it now");
    assert.equal(await stored(page, draftKey(AGENT, B)), "A: rename the backup job");
    pass(S, "Recover copies A's exact text into B's empty message box after an explicit choice, and sends nothing", { framesBefore });

    await openRecovery(page);
    await rows(page).filter({ hasText: "A: make deploy" }).click();
    await dialog(page).getByRole("button", { name: "Discard", exact: true }).click();
    await dialog(page).getByText("Discarded.").waitFor();
    assert.equal(await rows(page).filter({ hasText: "A: make deploy" }).count(), 0);
    assert.equal(await rows(page).filter({ hasText: "A: note for the cli pane" }).count(), 1);
    await closeRecovery(page);
    assert.equal(await stored(page, lineKey(SHELL, A)), null);
    assert.equal(await stored(page, draftKey(OTHER, A)), "A: note for the cli pane");
    assert.equal(await inputFrames(page), framesBefore);
    pass(S, "Discard removes only the record picked");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function failure(browser: Browser, base: string): Promise<void> {
  const S = "ambiguous-and-late-drafts";
  const context = await newContext(browser, { width: 1440, phone: false, theme: "dark", language: "en" });
  try {
    const now = Date.now();
    // drafts from before lifetimes, a malformed and an oversized record, and held input with control bytes
    await context.addInitScript(([agent, shell, other, at]) => {
      if (localStorage.getItem("herdr-web-ui:seeded") !== null) return;
      localStorage.setItem("herdr-web-ui:seeded", "1");
      localStorage.setItem(`herdr-web-ui:composer-draft:${agent}`, "legacy message from before lifetimes");
      localStorage.setItem(`herdr-web-ui:terminal-line:${shell}`, "legacy line");
      localStorage.setItem(`herdr-web-ui:terminal-draft:${other}`, JSON.stringify({ text: "held \u001b[2Jclear\u0007", truncated: false, leftOut: false, at }));
      localStorage.setItem(`herdr-web-ui:terminal-draft:${shell}`, "{not json");
      localStorage.setItem(`herdr-web-ui:terminal-line:${agent}`, "x".repeat(40_000));
    }, [AGENT, SHELL, OTHER, now] as const);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // an older bridge: no lifetime at all
    await page.goto(`${base}?pane=${encodeURIComponent(AGENT)}`);
    await restartBridge(page, { local: null }, AGENT, base);
    assert.equal(await page.evaluate(async () => "herdr_lifetime" in (await (await fetch("/api/session")).json()).snapshot), false);
    const keysBefore = await storageKeys(page);
    // no lens is remembered for an unproven pane: the desktop default, then a pick kept in this page alone
    await lensIs(page, "terminal");
    await page.locator("button[title^='Chat transcript']").first().click();
    await lensIs(page, "chat");
    await valueIs(page, ".composer-text", "");
    await composer(page).fill("typed while the herdr is unproven");
    await valueIs(page, ".composer-text", "typed while the herdr is unproven");
    await page.locator("button[title^='Live terminal']").first().click();
    await lensIs(page, "terminal");
    await page.locator("button[title^='Chat transcript']").first().click();
    await lensIs(page, "chat");
    assert.deepEqual(await storageKeys(page), keysBefore, "nothing of an unproven lifetime is stored");
    assert.equal((await storageKeys(page)).some((key) => key.includes("pane-state:v1:memory")), false);
    pass(S, "an older bridge (no lifetime) hydrates no legacy draft and stores nothing typed or picked", { keys: keysBefore.length });

    // recovery shows the legacy and broken records as inert text, Recover over a box with text asks first
    const framesBefore = await inputFrames(page);
    await openRecovery(page);
    const listed = await rows(page).allTextContents();
    assert.ok(listed.some((row) => row.includes("legacy message from before lifetimes") && row.includes("From before drafts were kept per herdr")));
    assert.ok(listed.some((row) => row.includes("Held input") && row.includes("held \u241b[2Jclear\u2407")), `held input is inert: ${JSON.stringify(listed)}`);
    await rows(page).filter({ hasText: "Cannot be read" }).first().click();
    assert.equal(await dialog(page).getByRole("button", { name: "Recover", exact: true }).count(), 0, "a broken record can only be discarded");
    await dialog(page).getByText(/cannot be read|Too large/).first().waitFor();
    await rows(page).filter({ hasText: "legacy message from before lifetimes" }).click();
    await dialog(page).getByRole("radio", { name: "Message box" }).check();
    await dialog(page).getByRole("button", { name: "Recover", exact: true }).click();
    await dialog(page).getByText("The message box already holds text. Replace it with this?").waitFor();
    assert.equal(await composer(page).inputValue(), "typed while the herdr is unproven", "nothing replaced before the second choice");
    await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await composer(page).inputValue(), "typed while the herdr is unproven");
    await dialog(page).getByRole("button", { name: "Recover", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Replace", exact: true }).click();
    await dialog(page).getByText("Recovered into the message box. Nothing was sent.").waitFor();
    await closeRecovery(page);
    await valueIs(page, ".composer-text", "legacy message from before lifetimes");
    assert.equal(await stored(page, `herdr-web-ui:composer-draft:${AGENT}`), null);
    assert.equal(await stored(page, `herdr-web-ui:terminal-line:${SHELL}`), "legacy line", "other legacy records stay");
    assert.equal(await inputFrames(page), framesBefore);
    pass(S, "a nonempty box is replaced only on a second explicit choice; broken records are discard-only; held control bytes are inert text");

    // an empty roster never deletes unsent text
    const kept = (await storageKeys(page)).filter((key) => key.includes("draft") || key.includes("terminal-line"));
    await page.evaluate(() => { (window as unknown as { emptyRoster: boolean }).emptyRoster = true; (window as unknown as { emitRoster(): void }).emitRoster(); });
    await page.waitForFunction(() => document.querySelectorAll("[data-pane]").length === 0, undefined, { timeout: 10_000 });
    assert.deepEqual((await storageKeys(page)).filter((key) => key.includes("draft") || key.includes("terminal-line")), kept);
    await page.evaluate(() => { (window as unknown as { emptyRoster: boolean }).emptyRoster = false; (window as unknown as { emitRoster(): void }).emitRoster(); });
    pass(S, "an empty roster deletes no unsent text", { kept: kept.length });

    // lifetime A proven again; a send on its way when herdr is replaced: its late receipt settles A alone
    // an agent held at rest: a message to it goes straight in (a working one's is queued and leaves
    // the box at once), and only its acknowledgement settles the draft
    const IDLE = panes.omp;
    await page.evaluate((pane) => sessionStorage.setItem("pane-lifetime-test:pinned", JSON.stringify({ [pane]: "idle" })), IDLE);
    await restartBridge(page, null, IDLE, base);
    await lensIs(page, "chat");
    await composer(page).fill("A: ship it");
    await valueIs(page, ".composer-text", "A: ship it");
    await page.evaluate(() => { (window as unknown as { holdAcks: boolean }).holdAcks = true; });
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForFunction(() => (window as unknown as { heldAcks(): number }).heldAcks() === 1, undefined, { timeout: 10_000 });
    assert.equal(await stored(page, draftKey(IDLE, A)), "A: ship it", "on its way, the draft stays A's");
    await page.evaluate((lifetime) => { const view = window as unknown as { lifetimes: Record<string, string>; emitRoster(): void }; view.lifetimes = { local: lifetime }; view.emitRoster(); }, B);
    // B inherits no lens either: its pane opens on the default, and its message box is empty
    await lensIs(page, "terminal");
    await page.locator("button[title^='Chat transcript']").first().click();
    await lensIs(page, "chat");
    await valueIs(page, ".composer-text", "");
    await composer(page).fill("B: typed meanwhile");
    await valueIs(page, ".composer-text", "B: typed meanwhile");
    await page.evaluate(() => (window as unknown as { releaseAcks(): void }).releaseAcks());
    await page.waitForFunction((key) => localStorage.getItem(key) === null, draftKey(IDLE, A), { timeout: 10_000 });
    assert.equal(await composer(page).inputValue(), "B: typed meanwhile", "A's late receipt never erases B's text");
    assert.equal(await stored(page, draftKey(IDLE, B)), "B: typed meanwhile");
    pass(S, "a proven replacement mid-send resets the box at once and A's late receipt settles A only");

    // the same pane IDs on another PC: its own owner, nothing of this PC's text
    await page.evaluate(() => { const view = window as unknown as { laptop: unknown; emitRoster(): void }; view.laptop = { name: "Laptop", state: "connected" }; view.emitRoster(); });
    await page.locator(`li[data-machine="laptop"][data-pane="${AGENT}"] .agent-select`).click();
    await page.locator(`li.agent-item.is-selected[data-machine="laptop"][data-pane="${AGENT}"]`).waitFor();
    // its pane inherits no lens of this PC's either: the default, then the chat by hand
    await lensIs(page, "terminal");
    await page.locator("button[title^='Chat transcript']").first().click();
    await lensIs(page, "chat");
    await valueIs(page, ".composer-text", "");
    assert.equal(await stored(page, draftKey(AGENT, B)), null);
    pass(S, "another PC with the same pane IDs shows none of this PC's text");

    // an observer may recover text into a box but cannot send it
    await page.evaluate(() => { const view = window as unknown as { laptop: unknown; emitRoster(): void }; view.laptop = null; view.emitRoster(); });
    await page.evaluate(([key]) => localStorage.setItem(key!, "recovered for an observer"), [draftKey(AGENT, "demo-herdr-earlier")]);
    await openPane(page, base, AGENT);
    await lensIs(page, "chat");
    await composer(page).fill("");
    await openRecovery(page);
    await rows(page).filter({ hasText: "recovered for an observer" }).click();
    await dialog(page).getByRole("radio", { name: "Message box" }).check();
    await dialog(page).getByRole("button", { name: "Recover", exact: true }).click();
    await closeRecovery(page);
    await valueIs(page, ".composer-text", "recovered for an observer");
    await page.evaluate(() => (window as unknown as { forceObserve(): void }).forceObserve());
    const observed = await inputFrames(page);
    await page.locator(".composer-send").click({ force: true, timeout: 2_000 }).catch(() => undefined);
    await composer(page).press("Enter").catch(() => undefined);
    assert.equal(await inputFrames(page), observed, "an observer sends nothing, recovered text included");
    assert.equal(await stored(page, draftKey(AGENT, A)), "recovered for an observer", "the recovered text waits in the pane's box");
    pass(S, "an observe connection cannot send recovered text");

    // no secret and no auth token is ever kept with the drafts
    const values = await page.evaluate(() => Object.entries(localStorage).map(([key, value]) => `${key}=${value.slice(0, 200)}`));
    assert.ok(values.every((entry) => !/token|secret|password/i.test(entry)), "no secret is persisted");
    pass(S, "no secret or token is kept in the stored drafts");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

/** The capture set (UI_EVIDENCE_DIR): every recovery state at 390 (iPhone 14) and 1440, light and dark, Korean at 390. */
async function captures(browser: Browser, base: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const variants = [
    { width: 390, phone: true, theme: "light", language: "en" }, { width: 390, phone: true, theme: "dark", language: "en" },
    { width: 1440, phone: false, theme: "light", language: "en" }, { width: 1440, phone: false, theme: "dark", language: "en" },
    { width: 390, phone: true, theme: "light", language: "ko" }, { width: 390, phone: true, theme: "dark", language: "ko" },
  ] as const;
  const long = `${"unbroken-path/".repeat(12)}${"a".repeat(180)} and a second line\nwith more words to wrap over the width of the dialog`;
  for (const variant of variants) {
    const context = await newContext(browser, variant);
    try {
      const at = Date.now();
      await context.addInitScript(([seeds]) => {
        if (localStorage.getItem("herdr-web-ui:seeded") !== null) return;
        localStorage.setItem("herdr-web-ui:seeded", "1");
        for (const [key, value] of seeds as [string, string][]) localStorage.setItem(key, value);
      }, [[
        [draftKey(AGENT, A), "Rename the backup job and rerun it"],
        [lineKey(SHELL, A), "make deploy ENV=staging"],
        [heldKey(OTHER, A), JSON.stringify({ text: "git status \u001b[1m", truncated: false, leftOut: false, at })],
        [draftKey(panes.web, A), long],
        [draftKey(panes.flaky, A), "Check why the flaky test fails on CI"],
        [`herdr-web-ui:composer-draft:${panes.hermes}`, "A draft from before drafts were kept per herdr"],
        [heldKey(panes.omp, A), "{broken"],
        [draftKey(AGENT, "demo-herdr-laptop-old", "laptop"), "Laptop draft for the release notes"],
      ]] as const);
      const page = await context.newPage();
      const name = (state: string): string => join(dir, `pane-recovery-${variant.width}-${variant.theme}${variant.language === "ko" ? "-ko" : ""}-${state}.png`);
      const shot = async (state: string): Promise<void> => { await page.screenshot({ path: name(state), animations: "disabled", caret: "hide" }); };
      await page.goto(`${base}?pane=${encodeURIComponent(AGENT)}`);
      // a second PC with the same pane IDs, named long, in every roster from here on
      await page.evaluate(() => sessionStorage.setItem("pane-lifetime-test:laptop", JSON.stringify({ name: "Laptop · a long PC name that wraps", state: "connected" })));
      // the same herdr after a bridge restart: the draft kept under its lifetime
      await openPane(page, base, AGENT);
      await page.locator(".composer-text").waitFor();
      await valueIs(page, ".composer-text", "Rename the backup job and rerun it");
      if (variant.language === "en") await shot("retained");
      // a replacement herdr: the same pane, an empty box, nothing filled in
      await restartBridge(page, { local: B }, AGENT, base);
      await valueIs(page, ".composer-text", "");
      if (variant.language === "en") await shot("clean");
      await page.locator(".composer-text").fill("Text already in the box");
      if (variant.phone) {
        // a phone's tab menu holds the open pane's actions
        await page.locator(".tab-strip-menu:visible").first().click();
        const item = page.getByRole("button", { name: variant.language === "ko" ? "보내지 않은 글 복구" : "Recover unsent text", exact: true });
        await item.waitFor();
        await shot("menu");
        await item.click();
        // the tab menu's sheet slides away before the dialog stands alone
        await item.waitFor({ state: "detached" });
      } else {
        await paneMenu(page);
        await page.getByRole("menuitem", { name: "Recover unsent text" }).hover();
        await shot("menu");
        await page.getByRole("menuitem", { name: "Recover unsent text" }).click();
      }
      const box = page.locator(".draft-recovery");
      await box.waitFor();
      // the menu's own sheet gone, and its last frame too, which slides out in an inert host of its own
      // at the end of <body> (lib/sheets.ts): the dialog alone over the pane
      await page.waitForFunction(() => document.querySelectorAll(".modal-scrim").length === 1 && document.querySelector("body > div[inert][aria-hidden='true']") === null, undefined, { timeout: 10_000 });
      await shot("list");
      const body = box.locator(".modal-body");
      await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      await shot("list-scrolled-end");
      await body.evaluate((node) => { node.scrollTop = 0; });
      if (!variant.phone) { await box.locator(".draft-recovery-row").nth(1).hover(); await shot("hover"); }
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await box.locator(".draft-recovery-row").first().focus();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => document.activeElement?.closest(".draft-recovery") !== null);
      await shot("focus-visible");
      const first = box.locator(".draft-recovery-row").first();
      const rect = await first.boundingBox();
      if (rect) { await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.down(); await shot("pressed"); await page.mouse.up(); }
      await box.locator(".draft-recovery-row").filter({ hasText: "Rename the backup job" }).waitFor();
      if (await box.locator(".draft-recovery-row[aria-pressed='true']").count() === 0) await box.locator(".draft-recovery-row").filter({ hasText: "Rename the backup job" }).click();
      await box.locator(".draft-recovery-detail").waitFor();
      await shot("detail-disabled");
      await box.getByRole("radio").first().check();
      await box.locator(".draft-recovery-actions .btn-primary").click();
      await box.locator(".draft-recovery-confirm").waitFor();
      await shot("confirm");
      await box.locator(".draft-recovery-confirm .btn-danger").click();
      await box.locator(".draft-recovery-note").filter({ hasText: /./ }).waitFor();
      await shot("recovered");
      await box.locator(".draft-recovery-row").filter({ hasText: "unbroken-path" }).click();
      await shot("long");
      await box.locator(".draft-recovery-row .is-problem").first().click();
      await box.locator(".draft-recovery-problem").waitFor();
      await shot("error");
      await box.locator(".draft-recovery-actions .btn-danger").click();
      await box.locator(".draft-recovery-note").filter({ hasText: /./ }).waitFor();
      await shot("discarded");
      // every record discarded: the empty list
      while (await box.locator(".draft-recovery-row").count() > 0) {
        await box.locator(".draft-recovery-row").first().click();
        await box.locator(".draft-recovery-actions .btn-danger").click();
      }
      await box.locator(".draft-recovery-empty").waitFor();
      await shot("empty");
      await box.locator(".modal-footer .btn").click();
      await box.waitFor({ state: "detached" });
      await valueIs(page, ".composer-text", "Rename the backup job and rerun it");
      if (variant.language === "en") {
        // an observer: the recovered text sits in the box, and nothing can send it
        await page.evaluate(() => (window as unknown as { forceObserve(): void }).forceObserve());
        // a view-only connection draws no message box at all: nothing it holds can be sent from here
        await page.locator(".composer-text").waitFor({ state: "detached" });
        await shot("observer");
      }
    } finally { await context.close(); }
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${control}\n    <script type="module"`));
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
  const base = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await happy(browser, base);
      await failure(browser, base);
      if (evidence) await captures(browser, base, evidence);
    } finally { await browser.close(); }
  } finally { server.stop(); }
  if (results) {
    mkdirSync(results, { recursive: true });
    for (const [scenario, checks] of Object.entries(scenarios)) {
      writeFileSync(join(results, `task-26-aoe-borrowings-${scenario}.json`), JSON.stringify({ scenario, result: "pass", tool: "bun scripts/pane-lifetime-demo-regression.ts (playwright-core, demo build, loopback)", checks }, null, 2));
    }
  }
} finally { rmSync(app, { recursive: true, force: true }); }
