/**
 * A pane's lens as the app stores it: under the pane in its herdr lifetime (src/lib/paneState.ts),
 * never the pane ID alone, which a herdr that replaced the last one reuses for other panes. Browser
 * checks that open a pane in a given lens store it with these before the page loads.
 */
import { finishHerdrIdentity, herdrLifetime } from "../server/finishes.ts";
import { LOCAL_MACHINE, paneStateStorageId } from "../shared/machines.ts";

/** Whose a pane's unsent state is on the herdr this process reaches (HERDR_SOCKET: the isolated test session), as its server names the lifetime. */
export function testPaneStateOwner(paneId: string, machineId = LOCAL_MACHINE): string {
  const identity = finishHerdrIdentity();
  if (identity === null) throw new Error("no herdr socket in reach to name the pane's lifetime");
  return paneStateStorageId(machineId, paneId, herdrLifetime(identity));
}

/** The key of a pane's lens on that herdr. */
export function paneLensKey(paneId: string, machineId = LOCAL_MACHINE): string {
  return `herdr-web-ui:view:${testPaneStateOwner(paneId, machineId)}`;
}

/** The key on the browser demo, whose PCs keep a fictional lifetime each (site/demo/transport.ts). */
export function demoPaneLensKey(paneId: string, machineId = LOCAL_MACHINE): string {
  return `herdr-web-ui:view:${paneStateStorageId(machineId, paneId, `demo-herdr-${machineId}`)}`;
}

/**
 * An init script storing each key's lens before the app runs. `firstLoad`: only while the page has
 * no settings yet, so a reload keeps what the app stored since.
 */
export function lensInitScript(lenses: Record<string, string>, firstLoad = false): { content: string } {
  const entries = JSON.stringify(Object.entries(lenses));
  const guard = firstLoad ? `if (localStorage.getItem("herdr-web-ui:settings") !== null) return;` : "";
  return { content: `(() => { ${guard} for (const [key, lens] of ${entries}) localStorage.setItem(key, lens); })();` };
}
