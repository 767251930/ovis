/**
 * Recover unsent text (a pane's menu): what this device kept for panes it can no longer prove are
 * the ones it was typed for (lib/draftRecovery.ts). Opened only by the user. Each record is inert
 * text with its PC, pane and kind; Recover copies it into a box of the pane the dialog was opened
 * from, only into the box the user picks, and over text already there only after a second
 * choice. Nothing is ever sent from here, and Discard removes the one record shown.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import "./DraftRecovery.css";

import type { Machine } from "../../shared/machines.ts";
import { discardDraft, recoverableDrafts, recoverDraft, type RecoveryDestination, type RecoveryRecord, type RecoverySource } from "../lib/draftRecovery.ts";
import { useT } from "../lib/i18n.ts";
import { paneStateOwner } from "../lib/paneState.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";

interface Props {
  machineId: string;
  paneId: string;
  machines: readonly Machine[];
  /** each PC's current herdr lifetime: its own records are its panes', not listed here */
  lifetimes: ReadonlyMap<string, string>;
  onClose: () => void;
}

export function DraftRecovery({ machineId, paneId, machines, lifetimes, onClose }: Props) {
  const t = useT();
  const id = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeButton });
  useSheetSwipe(surface, onClose);
  usePhoneSheetBack(() => { onClose(); });
  const [revision, setRevision] = useState(0);
  const records = useMemo((): RecoveryRecord[] => {
    void revision;
    try { return recoverableDrafts(window.localStorage, lifetimes, Date.now(), { machine_id: machineId, pane_id: paneId }); } catch { return []; }
  }, [lifetimes, machineId, paneId, revision]);
  const [selected, setSelected] = useState<string | null>(null);
  const record = records.find((item) => item.key === selected) ?? null;
  const [destination, setDestination] = useState<RecoveryDestination | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (confirming) setConfirming(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirming, onClose]);
  useEffect(() => { if (selected !== null) detail.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  useEffect(() => { if (confirming) confirmation.current?.scrollIntoView({ block: "nearest" }); }, [confirming]);

  const sourceLabel = (source: RecoverySource): string =>
    source === "message" ? t("Message draft") : source === "line" ? t("Terminal line") : t("Held input");
  const place = (item: RecoveryRecord): string => item.machine_id === ""
    ? t("Unknown PC")
    : t("{machine} · pane {pane}", { machine: machines.find((machine) => machine.id === item.machine_id)?.name ?? item.machine_id, pane: item.pane_id });
  const origin = (item: RecoveryRecord): string => item.origin === "earlier" ? t("From an earlier herdr") : t("From before drafts were kept per herdr");

  const pick = (key: string): void => {
    setSelected((current) => current === key ? null : key);
    setDestination(null);
    setConfirming(false);
    setNote(null);
  };
  const recover = (replace: boolean): void => {
    if (!record) return;
    const outcome = recoverDraft(record, destination, paneStateOwner(machineId, paneId, lifetimes.get(machineId)), replace);
    if (outcome === "confirm_replace") { setConfirming(true); return; }
    setConfirming(false);
    if (outcome === "too_long") { setNote(t("Too long for this box. Choose the other one, or discard it.")); return; }
    if (outcome !== "recovered") return;
    setNote(destination === "message" ? t("Recovered into the message box. Nothing was sent.") : t("Recovered into the terminal input line. Nothing was sent."));
    setSelected(null);
    setRevision((count) => count + 1);
  };
  const discard = (): void => {
    if (!record) return;
    discardDraft(record);
    setSelected(null);
    setConfirming(false);
    setNote(t("Discarded."));
    setRevision((count) => count + 1);
  };

  // the picked record opens under its own row, so what is recovered stays beside where it came from
  const detailOf = (record: RecoveryRecord) => (
    <section ref={detail} className="draft-recovery-detail" aria-label={sourceLabel(record.source)}>
      {record.problem === null
        ? <pre className="draft-recovery-text" tabIndex={0} aria-label={sourceLabel(record.source)}>{record.text}</pre>
        : <p className="draft-recovery-problem">{record.problem === "unreadable" ? t("This record cannot be read. It can only be discarded.") : t("Too large to recover here. It can only be discarded.")}</p>}
      {record.problem === null && (
        <fieldset className="draft-recovery-destinations">
          <legend>{t("Recover into")}</legend>
          {(["message", "line"] as const).map((value) => (
            <label key={value} className="draft-recovery-destination">
              <input type="radio" name={`${id}-destination`} value={value} checked={destination === value}
                onChange={() => { setDestination(value); setConfirming(false); setNote(null); }} />
              {value === "message" ? t("Message box") : t("Terminal input line")}
            </label>
          ))}
        </fieldset>
      )}
      {confirming && (
        <div ref={confirmation} className="draft-recovery-confirm" role="group" aria-labelledby={`${id}-confirm`}>
          <p id={`${id}-confirm`}>{destination === "message" ? t("The message box already holds text. Replace it with this?") : t("The terminal input line already holds text. Replace it with this?")}</p>
          <div className="draft-recovery-actions">
            <button type="button" className="btn" onClick={() => setConfirming(false)}>{t("Cancel")}</button>
            <button type="button" className="btn btn-danger" onClick={() => recover(true)}>{t("Replace")}</button>
          </div>
        </div>
      )}
      {!confirming && (
        <div className="draft-recovery-actions">
          <button type="button" className="btn btn-danger" onClick={discard}>{t("Discard")}</button>
          {record.problem === null && <button type="button" className="btn btn-primary" disabled={destination === null} onClick={() => recover(false)}>{t("Recover")}</button>}
        </div>
      )}
    </section>
  );

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal draft-recovery" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{t("Recover unsent text")}</h2></header>
        <div className="modal-body draft-recovery-body">
          <p className="draft-recovery-intro" id={`${id}-intro`}>{t("Text this device kept for a pane it can no longer tell apart from a new one: typed under an earlier herdr, or before drafts were kept per herdr. Nothing is filled in or sent until you choose.")}</p>
          {records.length === 0
            ? <p className="draft-recovery-empty">{t("No earlier unsent text on this device.")}</p>
            : <ul className="draft-recovery-list" aria-label={t("Recover unsent text")}>
              {records.map((item) => (
                <li key={item.key}>
                  <button type="button" className="draft-recovery-row" aria-pressed={item.key === selected} aria-expanded={item.key === selected} onClick={() => pick(item.key)}>
                    <span className="draft-recovery-row-head">
                      <span className="draft-recovery-kind">{sourceLabel(item.source)}</span>
                      <span className="draft-recovery-place">{place(item)}</span>
                    </span>
                    <span className="draft-recovery-origin">{origin(item)}</span>
                    <span className={`draft-recovery-preview${item.problem ? " is-problem" : ""}`}>{item.problem === null ? item.text : t("Cannot be read")}</span>
                  </button>
                  {item.key === selected && detailOf(item)}
                </li>
              ))}
            </ul>}
          <p className="draft-recovery-note" role="status">{note}</p>
        </div>
        <footer className="modal-footer">
          <button ref={closeButton} type="button" className="btn" onClick={onClose}>{t("Close")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
