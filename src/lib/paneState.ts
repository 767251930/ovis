import { createContext, useContext } from "react";
import { paneStateStorageId, parsePaneStateStorageId } from "../../shared/machines.ts";

/**
 * A page-only lifetime slot, for a PC whose snapshot proves no herdr lifetime (an older bridge, an
 * unreadable identity): what is typed there lives in this page and is never stored, nor read from
 * an earlier herdr's or a pre-lifetime key. Never a herdr digest, which is hex.
 */
export const memoryLifetime = (): string => `memory.${[...crypto.getRandomValues(new Uint32Array(4))].map((part) => part.toString(36)).join("")}`;

/** The slot of a PC no snapshot has named yet: it draws no pane, so nothing is typed under it. */
const UNSEEN_LIFETIME = memoryLifetime();

/** Whose a pane's drafts, held input and lens are: the PC, the pane and the herdr it lives in. */
export function paneStateOwner(machineId: string, paneId: string, lifetime: string | undefined): string {
  return paneStateStorageId(machineId, paneId, lifetime ?? UNSEEN_LIFETIME);
}

/**
 * One PC's lifetime on this page. `proven`: the last herdr lifetime a snapshot proved; `memory`:
 * the page-only slot used while snapshots prove none, minted while `proven` was `under`.
 */
export interface LifetimeGeneration { current: string; proven: string | null; memory: string | null; under: string | null }

/**
 * Each PC's lifetime after a roster change (`lifetime`: its snapshot's `herdr_lifetime`; `null`:
 * a snapshot without one; `undefined`: no snapshot, which changes nothing). A PC whose snapshots
 * prove no lifetime keeps one page-only slot through its reconnects, as long as no proven
 * lifetime came between them: after a herdr that replaced the last one, unknown is a new slot,
 * and the text typed under the earlier one never shows in the new herdr's panes.
 */
export function nextLifetimeGenerations(previous: ReadonlyMap<string, LifetimeGeneration>, roster: readonly (readonly [string, string | null | undefined])[], mint: () => string = memoryLifetime): Map<string, LifetimeGeneration> {
  const next = new Map<string, LifetimeGeneration>();
  for (const [machineId, lifetime] of roster) {
    const before = previous.get(machineId);
    if (lifetime === undefined) { if (before) next.set(machineId, before); continue; }
    const proven = lifetime ?? before?.proven ?? null;
    // a slot minted under another proven lifetime is that generation's, never this one's
    const kept = before?.memory != null && before.under === proven ? before.memory : null;
    if (lifetime !== null) { next.set(machineId, { current: lifetime, proven, memory: kept, under: kept === null ? null : proven }); continue; }
    const memory = kept ?? mint();
    next.set(machineId, { current: memory, proven, memory, under: proven });
  }
  return next;
}

/** True for a page-only owner (paneStateOwner without a lifetime): nothing of it goes to storage. */
export function memoryPaneState(owner: string): boolean {
  return parsePaneStateStorageId(owner)?.lifetime.startsWith("memory.") === true;
}

/** Each PC's `herdr_lifetime`, from its latest snapshot (App). A PC missing from it has none. */
export const PaneLifetimeContext = createContext<ReadonlyMap<string, string>>(new Map());
export const usePaneLifetimes = (): ReadonlyMap<string, string> => useContext(PaneLifetimeContext);
export function usePaneStateOwner(machineId: string, paneId: string): string {
  return paneStateOwner(machineId, paneId, usePaneLifetimes().get(machineId));
}

/** The storage key of a pane's message draft (lib/composerDraft.ts). */
export const composerDraftKey = (owner: string): string => `herdr-web-ui:composer-draft:${owner}`;
