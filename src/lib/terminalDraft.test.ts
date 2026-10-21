import { expect, it } from "bun:test";
import { ComposerDraftStore } from "./composerDraft.ts";
import { composerDraftKey, paneStateOwner } from "./paneState.ts";
import { acknowledgeTerminalDraft, readTerminalDraft, setTerminalDraftSending, terminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";

it("preserves edits across remounts and confines acknowledgements to the submitting PC/pane", () => {
  const owner = "remote-a:w1:p1";
  const other = "remote-b:w1:p1";
  writeTerminalDraft(owner, "sent");
  writeTerminalDraft(other, "other");
  setTerminalDraftSending(owner, true);
  expect(terminalDraftSending(owner)).toBe(true);
  writeTerminalDraft(owner, "sent plus 한글");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe(" plus 한글");
  expect(readTerminalDraft(other)).toBe("other");
});

it("does not erase a replacement even when the user retypes the same text before acknowledgement", () => {
  const owner = "edited:w1:p1";
  writeTerminalDraft(owner, "same text");
  setTerminalDraftSending(owner, true);
  writeTerminalDraft(owner, "");
  writeTerminalDraft(owner, "same text");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe("same text");
});

it("late acknowledgements affect only the original lifetime", () => {
  // a line sent from herdr A's pane: herdr is replaced and B reuses the pane ID before the answer comes
  const a = paneStateOwner("local", "w1:p1", "lifetime-a");
  const b = paneStateOwner("local", "w1:p1", "lifetime-b");
  writeTerminalDraft(a, "deploy");
  setTerminalDraftSending(a, true);
  expect(readTerminalDraft(b)).toBe("");
  writeTerminalDraft(b, "deploy");
  // the late receipt settles A's line and never erases what B's input holds
  acknowledgeTerminalDraft(a);
  setTerminalDraftSending(a, false);
  expect(readTerminalDraft(a)).toBe("");
  expect(readTerminalDraft(b)).toBe("deploy");
  expect(terminalDraftSending(b)).toBe(false);
  // the composer's settle keeps its owner too
  const data = new Map<string, string>();
  const store = new ComposerDraftStore(() => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }));
  store.set(composerDraftKey(a), "ship it");
  expect(store.begin(composerDraftKey(a), "ship it")).toBe(true);
  // B's box is not busy with A's send, and what is typed there stays through A's settle
  expect(store.read(composerDraftKey(b)).sending).toBe(false);
  store.set(composerDraftKey(b), "ship it");
  store.settle(composerDraftKey(a), "ship it");
  store.end(composerDraftKey(a));
  expect(store.read(composerDraftKey(a)).text).toBe("");
  expect(store.read(composerDraftKey(b))).toEqual({ text: "ship it", sending: false });
});

it("keeps a page-only owner's line in memory alone", () => {
  const owner = paneStateOwner("local", "w1:p9", undefined);
  const writes: string[] = [];
  const previous = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => "a bare-pane line", setItem: (key: string) => { writes.push(key); }, removeItem: (key: string) => { writes.push(key); } };
  try {
    expect(readTerminalDraft(owner)).toBe("");
    writeTerminalDraft(owner, "typed while unproven");
    expect(readTerminalDraft(owner)).toBe("typed while unproven");
    expect(writes).toEqual([]);
  } finally { (globalThis as { localStorage?: unknown }).localStorage = previous; }
});
