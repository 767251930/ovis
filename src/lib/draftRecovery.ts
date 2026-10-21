/**
 * Unsent text this device kept for a pane it can no longer prove is the same one: stored under an
 * earlier herdr lifetime (a herdr that replaced it reuses pane IDs for other panes), or before
 * drafts named their herdr at all. None of it is ever put back by itself; the recovery dialog lists
 * it as inert text, and only the user's choice copies one into a current box, or discards it.
 * A lens remembered for such a pane is not text and is never listed.
 */
import { LOCAL_MACHINE, parsePaneStateStorageId } from "../../shared/machines.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { composerDrafts, type ComposerDraftStore } from "./composerDraft.ts";
import { restoreDraft } from "./draft.ts";
import { composerDraftKey } from "./paneState.ts";
import { readTerminalDraft, TERMINAL_LINE_LIMIT, TERMINAL_LINE_PREFIX, writeTerminalDraft } from "./terminalDraft.ts";

/** message: the composer's draft; line: the terminal's input line; held: input held while disconnected */
export type RecoverySource = "message" | "line" | "held";
export type RecoveryDestination = "message" | "line";
export interface RecoveryRecord {
  /** its storage key: a discard removes this one record and no other */
  key: string;
  source: RecoverySource;
  machine_id: string;
  pane_id: string;
  /** earlier: another herdr lifetime's; legacy: kept before drafts named their herdr */
  origin: "earlier" | "legacy";
  /** shown and recovered as text only: control characters as their visible symbols */
  text: string;
  /** unreadable: not a draft this app wrote; too_large: past what its box ever holds */
  problem: "unreadable" | "too_large" | null;
}

const HELD_PREFIX = "herdr-web-ui:terminal-draft:";
const SOURCES: readonly [string, RecoverySource][] = [
  [composerDraftKey(""), "message"], [TERMINAL_LINE_PREFIX, "line"], [HELD_PREFIX, "held"],
];
const LIMITS: Record<RecoverySource, number> = { message: MAX_COMPOSER_CHARS, line: TERMINAL_LINE_LIMIT, held: TERMINAL_LINE_LIMIT };
const DESTINATION_LIMITS: Record<RecoveryDestination, number> = { message: MAX_COMPOSER_CHARS, line: TERMINAL_LINE_LIMIT };

/** Line breaks and tabs stay; every other control character becomes its visible symbol, never a key. */
export function inertText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "\u2421" : "\ufffd";
  });
}

/** The PC and pane of a key from before lifetimes: paneStorageId's own forms. */
function legacyOwner(owner: string): { machine_id: string; pane_id: string } | null {
  if (!owner.startsWith("remote:")) return owner ? { machine_id: LOCAL_MACHINE, pane_id: owner } : null;
  const parts = owner.slice("remote:".length).split(":");
  if (parts.length !== 2) return null;
  try { return { machine_id: decodeURIComponent(parts[0]!), pane_id: decodeURIComponent(parts[1]!) }; } catch { return null; }
}

/**
 * A held record's text, null for nothing to recover (empty, or past its time: draft.ts), or
 * `unreadable` for a record this app did not write. Tagged, so no text is ever taken for that.
 */
function heldText(raw: string, now: number): { text: string } | null | "unreadable" {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "unreadable"; }
  if (typeof value !== "object" || value === null || typeof (value as { text?: unknown }).text !== "string") return "unreadable";
  const text = restoreDraft(raw, now).text;
  return text ? { text } : null;
}

/**
 * Every record on this device that no current pane owns: an earlier lifetime's (each PC against
 * its own current one, `lifetimes`), or a legacy key's. The pane `first` names comes first.
 */
export function recoverableDrafts(storage: Pick<Storage, "length" | "key" | "getItem">, lifetimes: ReadonlyMap<string, string>, now: number, first?: { machine_id: string; pane_id: string }): RecoveryRecord[] {
  const records: RecoveryRecord[] = [];
  const keys: string[] = [];
  try { for (let index = 0; index < storage.length; index++) { const key = storage.key(index); if (key !== null) keys.push(key); } } catch { return []; }
  for (const key of keys) {
    const match = SOURCES.find(([prefix]) => key.startsWith(prefix));
    if (!match) continue;
    const [prefix, source] = match;
    const owner = key.slice(prefix.length);
    const tuple = parsePaneStateStorageId(owner);
    let place: { machine_id: string; pane_id: string } | null;
    let origin: RecoveryRecord["origin"];
    if (tuple) {
      // a page-only owner is never stored; the current lifetime's records are the panes' own
      if (tuple.lifetime.startsWith("memory.") || lifetimes.get(tuple.machine_id) === tuple.lifetime) continue;
      place = { machine_id: tuple.machine_id, pane_id: tuple.pane_id }; origin = "earlier";
    } else if (owner.startsWith("pane-state:")) {
      place = null; origin = "earlier";
    } else {
      place = legacyOwner(owner); origin = "legacy";
    }
    let raw: string | null = null;
    try { raw = storage.getItem(key); } catch { continue; }
    if (raw === null || raw === "") continue;
    let text = raw;
    let problem: RecoveryRecord["problem"] = place === null ? "unreadable" : null;
    if (source === "held" && problem === null) {
      const held = heldText(raw, now);
      if (held === null) continue;
      if (held === "unreadable") { problem = "unreadable"; text = ""; } else text = held.text;
    }
    if (problem === null && text.length > LIMITS[source]) problem = "too_large";
    records.push({ key, source, ...(place ?? { machine_id: "", pane_id: "" }), origin, text: problem === null ? inertText(text) : "", problem });
  }
  const rank = (record: RecoveryRecord): number => first && record.machine_id === first.machine_id && record.pane_id === first.pane_id ? 0 : 1;
  return records.sort((a, b) => rank(a) - rank(b) || a.machine_id.localeCompare(b.machine_id) || a.pane_id.localeCompare(b.pane_id) || a.key.localeCompare(b.key));
}

/** Where recovery reads and writes; the app's own stores unless a test gives its own. */
export interface RecoveryStores {
  storage: () => Pick<Storage, "removeItem">;
  composer: Pick<ComposerDraftStore, "read" | "set">;
  line: { read(owner: string): string; write(owner: string, text: string): void };
}
const appStores: RecoveryStores = {
  storage: () => window.localStorage,
  composer: composerDrafts,
  line: { read: readTerminalDraft, write: writeTerminalDraft },
};

/**
 * choose_destination: no box was picked; confirm_replace: the box holds text, and only a second
 * choice (`replace`) puts this over it; too_long: more than that box takes, nothing is cut.
 */
export type RecoverOutcome = "recovered" | "choose_destination" | "confirm_replace" | "too_long" | "unreadable";

/**
 * Copies a record into a current box of `owner` (paneStateOwner) at the user's choice, then
 * removes the record, which the box now holds. Nothing is sent: the text waits in the box.
 */
export function recoverDraft(record: RecoveryRecord, destination: RecoveryDestination | null, owner: string, replace: boolean, stores: RecoveryStores = appStores): RecoverOutcome {
  if (destination === null) return "choose_destination";
  if (record.problem !== null) return "unreadable";
  if (record.text.length > DESTINATION_LIMITS[destination]) return "too_long";
  const current = destination === "message" ? stores.composer.read(composerDraftKey(owner)).text : stores.line.read(owner);
  if (current !== "" && !replace) return "confirm_replace";
  if (destination === "message") stores.composer.set(composerDraftKey(owner), record.text);
  else stores.line.write(owner, record.text);
  discardDraft(record, stores);
  return "recovered";
}

/** Removes this one record, wherever this page also keeps it. */
export function discardDraft(record: RecoveryRecord, stores: RecoveryStores = appStores): void {
  if (record.source === "message") stores.composer.set(record.key, "");
  else if (record.source === "line") stores.line.write(record.key.slice(TERMINAL_LINE_PREFIX.length), "");
  try { stores.storage().removeItem(record.key); } catch { /* private mode: nothing was stored */ }
}
