import { createContext, useContext } from "react";
import { paneStateStorageId, parsePaneStateStorageId } from "../../shared/machines.ts";

/**
 * The lifetime slot of a PC whose snapshot proves no herdr lifetime (an older bridge, an
 * unreadable identity): this page's own, so what is typed there lives in this page through its
 * reconnects and is never stored, nor read from an earlier herdr's or a pre-lifetime key. Never a
 * herdr digest, which is hex.
 */
const PAGE_LIFETIME = `memory.${[...crypto.getRandomValues(new Uint32Array(4))].map((part) => part.toString(36)).join("")}`;

/** Whose a pane's drafts, held input and lens are: the PC, the pane and the herdr it lives in. */
export function paneStateOwner(machineId: string, paneId: string, lifetime: string | undefined): string {
  return paneStateStorageId(machineId, paneId, lifetime ?? PAGE_LIFETIME);
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
