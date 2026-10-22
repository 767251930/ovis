/**
 * Recover unsent text (a pane's menu): what this device kept for panes it can no longer prove are
 * the ones it was typed for (lib/draftRecovery.ts). Opened only by the user. Each record is inert
 * text with its PC, pane and kind; Recover copies it into a box of the pane the dialog was opened
 * from, only into the box the user picks, and over text already there only after a second
 * choice. Nothing is ever sent from here, and Discard removes the one record shown.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

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
  // another tab writing a listed record (or removing it) lists it again, as it now is
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.storageArea === window.localStorage) setRevision((count) => count + 1); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  /** the version picked: the record as it was shown, never a newer text another tab wrote since */
  const [selected, setSelected] = useState<{ key: string; raw: string } | null>(null);
  const record = selected === null ? null : records.find((item) => item.key === selected.key && item.raw === selected.raw) ?? null;
  const [destination, setDestination] = useState<RecoveryDestination | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // the box picked and the confirmation are for the pane's herdr they were given under
  const owner = paneStateOwner(machineId, paneId, lifetimes.get(machineId));
  const [choiceOwner, setChoiceOwner] = useState(owner);
  const detail = useRef<HTMLElement>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const noteLine = useRef<HTMLParagraphElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /**
   * where the keyboard goes once the control it was on is gone: Cancel when the confirmation
   * opens, Recover when it closes, the first row (or Close) once a record leaves the list
   */
  const [refocus, setRefocus] = useState<"cancel" | "recover" | "list" | "lost" | null>(null);

  // Another herdr behind the pane, or another tab's write to the picked record, drops the pick, the
  // box and the confirmation in this same render, never a frame later: a Replace or Recover still
  // on screen would act for a pane or a text the user did not choose.
  const ownerLost = choiceOwner !== owner;
  const recordLost = selected !== null && record === null;
  if (ownerLost || recordLost) {
    const picked = selected !== null || destination !== null || confirming;
    setChoiceOwner(owner);
    setSelected(null);
    setDestination(null);
    setConfirming(false);
    if (picked) {
      setNote(ownerLost ? t("This pane is now in another herdr. Pick the text and the box again.") : t("This text changed in another tab. Look at it again before you recover it."));
      setRefocus("lost");
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.stopPropagation();
      event.preventDefault();
      if (confirming) { setConfirming(false); setRefocus("recover"); }
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirming, onClose]);
  // what opens is brought into view by a glide of the body, not a jump (at once with reduced motion)
  // A row still sliding into place is aimed at where it lands, once it is there.
  const reveal = (node: HTMLElement | null): void => {
    if (!node) return;
    const glide = (): void => node.scrollIntoView({ block: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true ? "auto" : "smooth" });
    const key = node.closest<HTMLElement>(".draft-recovery-item")?.dataset.key;
    const slide = key === undefined ? undefined : slides.current.get(key);
    if (slide?.playState === "running") slide.finished.then(glide, glide);
    else glide();
  };
  const pickedKey = selected?.key ?? null;
  useEffect(() => { if (pickedKey !== null) reveal(detail.current); }, [pickedKey]);
  useEffect(() => { if (confirming) reveal(confirmation.current); }, [confirming]);
  useEffect(() => { if (note !== null) reveal(noteLine.current); }, [note]);
  useEffect(() => {
    if (refocus === null) return;
    setRefocus(null);
    const root = surface.current;
    // the keyboard moves on only when the control it was on went with the pick
    if (refocus === "lost" && root?.contains(document.activeElement)) return;
    const target = refocus === "cancel" ? root?.querySelector<HTMLElement>(".draft-recovery-confirm .btn:not(.btn-danger)")
      : refocus === "recover" ? detail.current?.querySelector<HTMLElement>(".btn-primary")
      : list.current?.querySelector<HTMLElement>(".draft-recovery-row") ?? closeButton.current;
    target?.focus({ preventScroll: true });
  }, [refocus, surface]);

  const sourceLabel = (source: RecoverySource): string =>
    source === "message" ? t("Message draft") : source === "line" ? t("Terminal line") : t("Held input");
  const place = (item: RecoveryRecord): string => item.machine_id === ""
    ? t("Unknown PC")
    : t("{machine} · pane {pane}", { machine: machines.find((machine) => machine.id === item.machine_id)?.name ?? item.machine_id, pane: item.pane_id });
  const origin = (item: RecoveryRecord): string => item.origin === "earlier" ? t("From an earlier herdr") : t("From before drafts were kept per herdr");

  const pick = (item: RecoveryRecord): void => {
    setSelected((current) => current?.key === item.key ? null : { key: item.key, raw: item.raw });
    setDestination(null);
    setConfirming(false);
    setNote(null);
  };
  const recover = (replace: boolean): void => {
    if (!record) return;
    if (choiceOwner !== owner) return;
    const outcome = recoverDraft(record, destination, owner, replace);
    if (outcome === "confirm_replace") { setConfirming(true); setRefocus("cancel"); return; }
    setConfirming(false);
    if (outcome === "changed") { changed(); return; }
    if (outcome === "too_long") { setNote(t("Too long for this box. Choose the other one, or discard it.")); return; }
    if (outcome !== "recovered") return;
    setNote(destination === "message" ? t("Recovered into the message box. Nothing was sent.") : t("Recovered into the terminal input line. Nothing was sent."));
    setSelected(null);
    setRevision((count) => count + 1);
    setRefocus("list");
  };
  /** the record is no longer the version shown: nothing was done, and it is listed again as it is */
  const changed = (): void => {
    setSelected(null);
    setDestination(null);
    setConfirming(false);
    setNote(t("This text changed in another tab. Look at it again before you recover it."));
    setRevision((count) => count + 1);
    setRefocus("list");
  };
  const discard = (): void => {
    if (!record) return;
    if (discardDraft(record) === "changed") { changed(); return; }
    setSelected(null);
    setConfirming(false);
    setNote(t("Discarded."));
    setRevision((count) => count + 1);
    setRefocus("list");
  };

  // Rows move to where a record that opened, closed or went leaves them, from where they were:
  // nothing jumps under the pointer. With reduced motion they fade in place instead.
  const rowTops = useRef(new Map<string, number>());
  const slides = useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const rows = list.current;
    const body = rows?.parentElement;
    const tops = new Map<string, number>();
    if (rows && body) {
      const origin = body.getBoundingClientRect().top - body.scrollTop;
      const tokens = getComputedStyle(rows);
      const duration = parseFloat(tokens.getPropertyValue("--dur-base")) || 0;
      const easing = tokens.getPropertyValue("--ease-out").trim() || "ease-out";
      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
      for (const row of rows.children) {
        const key = row instanceof HTMLElement ? row.dataset.key : undefined;
        if (key === undefined) continue;
        // where it is on screen now, a slide still running included, then where it lays out
        const shown = row.getBoundingClientRect().top - origin;
        slides.current.get(key)?.cancel();
        slides.current.delete(key);
        const top = row.getBoundingClientRect().top - origin;
        tops.set(key, top);
        const before = rowTops.current.get(key);
        if (before === undefined || before === top || duration === 0) continue;
        const from = before - top + (shown - top);
        slides.current.set(key, (row as HTMLElement).animate(still ? [{ opacity: 0.4 }, { opacity: 1 }] : [{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration, easing }));
      }
    }
    rowTops.current = tops;
  });

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
            <button type="button" className="btn" onClick={() => { setConfirming(false); setRefocus("recover"); }}>{t("Cancel")}</button>
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
          {/* what was just done, where the eye returns after the row it came from goes */}
          <p ref={noteLine} className="draft-recovery-note" role="status">{note}</p>
          {records.length === 0
            ? <p className="draft-recovery-empty">{t("No earlier unsent text on this device.")}</p>
            : <ul ref={list} className="draft-recovery-list" aria-label={t("Recover unsent text")}>
              {records.map((item, index) => (
                <li key={item.key} data-key={item.key} className={`draft-recovery-item${item.key === record?.key ? " is-picked" : ""}`}>
                  {/* the row's button picks it; what it names (PC, pane, where it came from) is text
                      beside it, which can be selected and copied as any other text */}
                  <button type="button" className="draft-recovery-row" aria-pressed={item.key === record?.key} aria-expanded={item.key === record?.key}
                    aria-describedby={`${id}-meta-${index}`} onClick={() => pick(item)}>
                    <span className="draft-recovery-kind">{sourceLabel(item.source)}</span>
                    {/* picked: a check, with the wash, never the colour alone */}
                    <span className="draft-recovery-mark" aria-hidden="true">{item.key === record?.key && <Check />}</span>
                  </button>
                  <div className="draft-recovery-meta" id={`${id}-meta-${index}`}>
                    <span className="draft-recovery-place">{place(item)}</span>
                    <span className="draft-recovery-origin">{origin(item)}</span>
                    <span className={`draft-recovery-preview${item.problem ? " is-problem" : ""}`}>{item.problem === null ? item.text : t("Cannot be read")}</span>
                  </div>
                  {item.key === record?.key && detailOf(item)}
                </li>
              ))}
            </ul>}
        </div>
        <footer className="modal-footer">
          <button ref={closeButton} type="button" className="btn" onClick={onClose}>{t("Close")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
