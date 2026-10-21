import { expect, it, setSystemTime } from "bun:test";
import { ComposerDraftStore, SEND_LEASE_MS, storageEventDraft } from "./composerDraft.ts";
import { DRAFT_TTL_MS } from "./draft.ts";
import { discardDraft, recoverableDrafts, recoverDraft, type RecoveryStores } from "./draftRecovery.ts";
import { composerDraftKey, memoryPaneState, paneStateOwner } from "./paneState.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, store: new ComposerDraftStore(() => storage) };
}
it("keeps the draft busy and intact until an acknowledged send settles, and releases a refused send for retry", () => {
  const { store } = fixture();
  store.set("a", "check delivery");
  expect(store.begin("a", "check delivery")).toBe(true);
  expect(store.read("a")).toEqual({ text: "check delivery", sending: true });
  expect(store.begin("a", "check delivery")).toBe(false);
  store.settle("a", "check delivery");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "", sending: false });
  store.set("a", "retry this");
  store.begin("a", "retry this");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "retry this", sending: false });
  expect(store.begin("a", "retry this")).toBe(true);
});
it("settles an unmounted pane's draft and pending send without changing another owner", () => {
  const { store, data } = fixture();
  store.set("local:a", "sent"); store.begin("local:a");
  store.set("remote:a", "other PC");
  expect(store.begin("local:a")).toBe(false);
  store.settle("local:a", "sent"); store.end("local:a");
  expect(store.read("local:a")).toEqual({ text: "", sending: false });
  expect(data.has("local:a")).toBe(false);
  expect(store.read("remote:a").text).toBe("other PC");
});
it("preserves appended text, internal edits and newer edits from another tab", () => {
  const { store, data } = fixture();
  store.set("a", "sent plus next");
  expect(store.settle("a", "sent")).toEqual({ text: " plus next", edited: false });
  store.set("a", "edited sent");
  expect(store.settle("a", "sent")).toEqual({ text: "edited sent", edited: true });
  data.set("a", "another tab's draft");
  expect(store.settle("a", "sent").text).toBe("another tab's draft");
});
it("notifies a remounted composer and keeps a failed send's draft", () => {
  const { store } = fixture();
  store.set("a", "sent"); store.begin("a");
  let updates = 0;
  const off = store.subscribe(() => { updates++; });
  store.end("a");
  expect(store.read("a").text).toBe("sent");
  store.settle("a", "sent");
  expect(updates).toBe(2);
  off();
});
it("retains unsaved edits when browser storage is unavailable", () => {
  const store = new ComposerDraftStore(() => { throw new Error("blocked"); });
  store.set("a", "sent then next");
  expect(store.settle("a", "sent").text).toBe(" then next");
});
it("keeps a draft cleared and retyped while its send was on its way", () => {
  const { store } = fixture();
  store.set("a", "a"); store.begin("a", "a");
  store.set("a", ""); store.set("a", "ab");
  expect(store.settle("a", "a")).toEqual({ text: "ab", edited: true });
  store.end("a");
  // a plain append during the next send still loses only the sent prefix
  store.set("a", "x"); store.begin("a", "x");
  store.set("a", "xy");
  expect(store.settle("a", "x")).toEqual({ text: "y", edited: false });
  store.end("a");
});
it("keeps a draft another tab cleared and retyped while this tab's send was on its way", () => {
  const { store, data } = fixture();
  store.set("a", "sent"); store.begin("a", "sent");
  data.delete("a"); store.refresh("a");
  data.set("a", "sent again"); store.refresh("a");
  expect(store.settle("a", "sent")).toEqual({ text: "sent again", edited: true });
  store.end("a");
});
it("refuses a second tab's send while the first is still on its way", () => {
  const { data, store: first } = fixture();
  const second = new ComposerDraftStore(() => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  }));
  first.set("a", "do the thing");
  first.begin("a", "do the thing");
  // the other tab reads the same draft and sees the send, so it cannot send it again
  second.read("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: true });
  expect(second.begin("a")).toBe(false);
  // the first tab's end is what releases it, and the draft text is still there to send
  first.end("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: false });
  expect(second.begin("a")).toBe(true);
});
it("honours another tab's send as a lease, not forever", () => {
  const { data, store } = fixture();
  data.set("herdr-web-ui:composer-sending:a", JSON.stringify({ sent: "x", at: Date.now() - SEND_LEASE_MS - 1 }));
  store.read("a");
  store.refresh("a");
  expect(store.read("a").sending).toBe(false);
  expect(store.begin("a")).toBe(true);
});
it("ignores a hand-edited sending record instead of blocking the pane", () => {
  const { data, store } = fixture();
  data.set("herdr-web-ui:composer-sending:a", "not json");
  store.read("a");
  store.refresh("a");
  expect(store.begin("a")).toBe(true);
});
it("still reconciles another tab's text when no send is in flight", () => {
  const { data, store } = fixture();
  store.set("a", "mine");
  store.refresh("a");
  data.set("a", "theirs");
  store.refresh("a");
  expect(store.read("a").text).toBe("theirs");
});

it("names the draft another tab's edit or send concerns, and nothing else", () => {
  const key = "herdr-web-ui:composer-draft:local:w1:p1";
  expect(storageEventDraft(key)).toBe(key);
  expect(storageEventDraft(`herdr-web-ui:composer-sending:${key}`)).toBe(key);
  expect(storageEventDraft("herdr-web-ui:settings")).toBeNull();
  expect(storageEventDraft(null)).toBeNull();
});

it("lets a tab send again once another tab's abandoned lease runs out, and tells its composer", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const wakeUps: Array<{ run: () => void; ms: number }> = [];
  const closed = new ComposerDraftStore(() => storage);
  const other = new ComposerDraftStore(() => storage, (run, ms) => { wakeUps.push({ run, ms }); return 0; });
  const key = "herdr-web-ui:composer-draft:local:w1:p1";
  const start = Date.now();
  try {
    setSystemTime(start);
    expect(closed.begin(key, "hello")).toBe(true);
    // the other tab hears of the lease; the sending tab then closes without ending it
    other.refresh(key);
    expect(other.read(key).sending).toBe(true);
    expect(other.begin(key, "hello")).toBe(false);
    expect(wakeUps.length).toBe(1);
    expect(wakeUps[0]!.ms).toBeGreaterThan(SEND_LEASE_MS - 1000);
    let told = 0;
    other.subscribe(() => { told += 1; });
    setSystemTime(start + SEND_LEASE_MS + 1);
    wakeUps[0]!.run();
    expect(other.read(key).sending).toBe(false);
    expect(told).toBe(1);
    expect(other.begin(key, "hello")).toBe(true);
  } finally {
    setSystemTime();
  }
});

/** A whole device: storage that lists its keys, the composer store and the terminal lines over it. */
function device() {
  const data = new Map<string, string>();
  const storage = {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const store = new ComposerDraftStore(() => storage);
  const lines = new Map<string, string>();
  const stores: RecoveryStores = {
    storage: () => storage, composer: store,
    line: { read: (owner) => lines.get(owner) ?? data.get(`herdr-web-ui:terminal-line:${owner}`) ?? "", write: (owner, text) => {
      lines.set(owner, text);
      if (text) data.set(`herdr-web-ui:terminal-line:${owner}`, text); else data.delete(`herdr-web-ui:terminal-line:${owner}`);
    } },
  };
  return { data, storage, store, stores, lines };
}
it("proven herdr replacement isolates a reused pane id", () => {
  const { data, storage, store } = device();
  const a = composerDraftKey(paneStateOwner("local", "w1:p1", "lifetime-a"));
  const b = composerDraftKey(paneStateOwner("local", "w1:p1", "lifetime-b"));
  store.set(a, "typed for the pane of herdr A");
  // herdr B reuses the pane ID: its box starts empty, and what it gets never touches A's
  expect(store.read(b)).toEqual({ text: "", sending: false });
  store.set(b, "typed for B");
  expect(data.get(a)).toBe("typed for the pane of herdr A");
  // another PC with the same pane ID and even the same lifetime string is its own owner
  expect(store.read(composerDraftKey(paneStateOwner("laptop", "w1:p1", "lifetime-a"))).text).toBe("");
  // A's text is listed for recovery once B is current, B's is not
  const listed = recoverableDrafts(storage, new Map([["local", "lifetime-b"]]), Date.now());
  expect(listed.map((record) => [record.key, record.origin, record.text])).toEqual([[a, "earlier", "typed for the pane of herdr A"]]);
});
it("unknown lifetime never hydrates a bare-pane draft", () => {
  const { data, storage, store } = device();
  data.set("herdr-web-ui:composer-draft:w1:p1", "typed before drafts named their herdr");
  data.set("herdr-web-ui:composer-draft:remote:laptop:w1%3Ap1", "a remote PC's, from then");
  const owner = paneStateOwner("local", "w1:p1", undefined);
  expect(memoryPaneState(owner)).toBe(true);
  // the same page-only owner across the connection's reconnects, never the bare key's
  expect(paneStateOwner("local", "w1:p1", undefined)).toBe(owner);
  expect(store.read(composerDraftKey(owner)).text).toBe("");
  store.set(composerDraftKey(owner), "typed while the herdr is unproven");
  expect(store.begin(composerDraftKey(owner), "typed while the herdr is unproven")).toBe(true);
  store.end(composerDraftKey(owner));
  expect(store.read(composerDraftKey(owner)).text).toBe("typed while the herdr is unproven");
  // nothing of the page-only owner reached storage, and the legacy records are still there for recovery
  expect([...data.keys()].sort()).toEqual(["herdr-web-ui:composer-draft:remote:laptop:w1%3Ap1", "herdr-web-ui:composer-draft:w1:p1"]);
  expect(recoverableDrafts(storage, new Map(), Date.now()).map((record) => [record.machine_id, record.pane_id, record.origin]))
    .toEqual([["laptop", "w1:p1", "legacy"], ["local", "w1:p1", "legacy"]]);
});
it("recovery requires explicit destination choice", () => {
  const { data, storage, store, stores } = device();
  const now = Date.now();
  const current = paneStateOwner("local", "w1:p1", "lifetime-b");
  data.set(composerDraftKey(paneStateOwner("local", "w1:p1", "lifetime-a")), "git push --force-with-lease");
  data.set(`herdr-web-ui:terminal-line:${paneStateOwner("local", "w1:p2", "lifetime-a")}`, "make test");
  data.set(`herdr-web-ui:terminal-draft:${paneStateOwner("local", "w1:p3", "lifetime-a")}`, JSON.stringify({ text: "echo \u001b[31mred\u0007", truncated: false, leftOut: false, at: now }));
  data.set(`herdr-web-ui:terminal-draft:${paneStateOwner("local", "w1:p4", "lifetime-a")}`, "{not json");
  data.set(`herdr-web-ui:terminal-draft:${paneStateOwner("local", "w1:p5", "lifetime-a")}`, JSON.stringify({ text: "expired", at: now - DRAFT_TTL_MS - 1 }));
  data.set(`herdr-web-ui:terminal-line:${paneStateOwner("local", "w1:p6", "lifetime-a")}`, "x".repeat(40_000));
  data.set("herdr-web-ui:view:w1:p1", "chat");
  const lifetimes = new Map([["local", "lifetime-b"]]);
  const listed = recoverableDrafts(storage, lifetimes, now, { machine_id: "local", pane_id: "w1:p1" });
  // an expired held draft keeps its expiry, a lens is not text: neither is listed
  expect(listed.map((record) => [record.pane_id, record.source, record.problem])).toEqual([
    ["w1:p1", "message", null], ["w1:p2", "line", null], ["w1:p3", "held", null], ["w1:p4", "held", "unreadable"], ["w1:p6", "line", "too_large"],
  ]);
  // held control bytes are inert text, never keys
  expect(listed[2]!.text).toBe("echo \u241b[31mred\u2407");
  expect(recoverDraft(listed[3]!, "message", current, false, stores)).toBe("unreadable");
  expect(recoverDraft(listed[4]!, "line", current, false, stores)).toBe("unreadable");
  // nothing happens before a box is picked
  expect(recoverDraft(listed[0]!, null, current, false, stores)).toBe("choose_destination");
  expect(store.read(composerDraftKey(current)).text).toBe("");
  expect(data.has(listed[0]!.key)).toBe(true);
  // an empty box takes the exact text; the record it came from goes, no other
  expect(recoverDraft(listed[0]!, "message", current, false, stores)).toBe("recovered");
  expect(store.read(composerDraftKey(current))).toEqual({ text: "git push --force-with-lease", sending: false });
  expect(data.has(listed[0]!.key)).toBe(false);
  expect(data.has(listed[1]!.key)).toBe(true);
  // a box holding text is replaced only on the second, explicit choice
  expect(recoverDraft(listed[1]!, "message", current, false, stores)).toBe("confirm_replace");
  expect(store.read(composerDraftKey(current)).text).toBe("git push --force-with-lease");
  expect(data.has(listed[1]!.key)).toBe(true);
  expect(recoverDraft(listed[1]!, "line", current, false, stores)).toBe("recovered");
  expect(stores.line.read(current)).toBe("make test");
  expect(recoverDraft(listed[2]!, "line", current, false, stores)).toBe("confirm_replace");
  expect(recoverDraft(listed[2]!, "line", current, true, stores)).toBe("recovered");
  expect(stores.line.read(current)).toBe("echo \u241b[31mred\u2407");
  // Discard removes the one record picked
  const rest = recoverableDrafts(storage, lifetimes, now);
  expect(rest.map((record) => record.pane_id)).toEqual(["w1:p4", "w1:p6"]);
  discardDraft(rest[0]!, stores);
  expect(recoverableDrafts(storage, lifetimes, now).map((record) => record.pane_id)).toEqual(["w1:p6"]);
  expect(data.get("herdr-web-ui:view:w1:p1")).toBe("chat");
});
