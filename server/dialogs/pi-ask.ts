import type { DialogReader } from "./registry.ts";
import { ANSI_RE, KEY, type AnswerStep, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, keySteps, navigationKeys, normalizeText } from "./shared.ts";

// rpiv-ask-user-question uses ui.custom, not Pi's native select widget. Its numbered
// rows are cursor positions, NOT numeric shortcuts. Keep it separate from pi.ts.
const HINT_RE = /^Enter to select · ↑\/↓ to navigate(?: ·.*|…)?$/;
const RULE_RE = /^─{8,}$/;
const ROW_RE = /^(❯ | {2})(\d+)\.\s*(.*)$/;
const CURSOR_APC_RE = /\u001b_pi:[^\u0007]*\u0007/g;
const OTHER = "Type something.";

interface Frame { lines: string[]; hint: string; top: number; bottom: number; hintIndex: number }

/** Only the widget's own hint, optionally followed by Pi's folder/context footer, may own input. */
function frame(screen: string): Frame | null {
  const lines = screen.replace(ANSI_RE, "").replace(CURSOR_APC_RE, "").split(/\r?\n/).map(line => line.trimEnd());
  const hintIndex = findLastIndex(lines, line => HINT_RE.test(line.trim()));
  if (hintIndex < 0) return null;
  const tail = lines.slice(hintIndex + 1).map(line => line.trim()).filter(Boolean);
  if (tail.length) {
    // Standalone overlay: no footer. Inline editor: folder + context directly under the
    // widget's hint; native/older compositions can put a rule before those same two lines.
    // Never accept a new composer or arbitrary output after a stale copy of the widget.
    const footer = RULE_RE.test(tail[0] ?? "") ? tail.slice(1) : tail;
    if (footer.length !== 2
      || !/^(?:[A-Za-z]:[\\/]|[~\/])/.test(footer[0] ?? "")
      || !/\d+(?:\.\d+)?%\/\d/.test(footer[1] ?? "")
      || /^[❯›>]/.test(footer[1]!)) return null;
  }
  const bottom = findLastIndex(lines.slice(0, hintIndex), line => RULE_RE.test(line));
  const top = findLastIndex(lines.slice(0, bottom), line => RULE_RE.test(line));
  if (top < 0 || bottom < 0) return null;
  // Notes editors add their own rules; side-by-side previews add a second column. Neither
  // is a complete, unambiguous row list in a plain screen mirror. Leave those to Terminal.
  if (lines.slice(top + 1, bottom).some(line => /[│┌┐└┘]|^\s*(?:Notes:|Global note:|Note for this answer:)/.test(line))) return null;
  return { lines, hint: lines[hintIndex]!.trim(), top, bottom, hintIndex };
}

interface Row { label: string; description: string[]; selected: boolean; checked: boolean; box: boolean }

function question(frame: Frame): ParsedPrompt | null {
  const { lines, top, bottom, hint, hintIndex } = frame;
  if (lines.slice(bottom + 1, hintIndex).some(line => line.trim())) return null;
  const first = lines.findIndex((line, index) => index > top && index < bottom && ROW_RE.test(line));
  if (first < 0) return null;
  const rows: Row[] = [];
  let next: { label: string; selected: boolean } | null = null;
  for (const line of lines.slice(first, bottom)) {
    if (!line.trim()) continue;
    const match = line.match(ROW_RE);
    if (match) {
      if (next || Number(match[2]) !== rows.length + 1) return null;
      const box = match[3]!.match(/^\[([ ✔xX])\]\s*(.*)$/);
      rows.push({ label: box ? box[2]! : match[3]!, description: [], selected: match[1] === "❯ ", checked: !!box && box[1] !== " ", box: !!box });
    } else if (/^(?:❯ | {2})(?:Next|Submit)$/.test(line)) {
      if (next) return null;
      next = { label: line.trim().replace(/^❯ /, ""), selected: line.startsWith("❯ ") };
    } else {
      const row = rows.at(-1);
      if (!row || next || !/^\s{2,}\S/.test(line) || /…|\.\.\.|^\s*[↑↓]/.test(line)) return null;
      row.description.push(line.trim());
    }
  }
  const multi = rows[0]?.box === true;
  if (rows.length < 3 || rows.length > 5 || rows.some(row => row.box !== multi)
    || (multi !== (next !== null)) || (!multi && /Space to toggle/.test(hint))) return null;
  if (rows.filter(row => row.selected).length + Number(next?.selected ?? false) !== 1) return null;
  const other = rows.at(-1)!;
  // Focusing Other immediately opens the inline editor: its placeholder disappears. This
  // variant is identified by the input-specific hint, never by arbitrary numbered prose.
  const typing = other.selected && /Shift\+Enter for newline|Ctrl\+U to clear/.test(hint);
  if (other.label !== OTHER && !typing) return null;
  if (other.description.length || rows.slice(0, -1).some(row => !row.label || /…$/.test(row.label))) return null;
  // A multi-pick from the web must not silently include a custom draft owned by the terminal.
  if (multi && (other.checked || (typing && other.label.trim()))) return null;
  const heading = lines.slice(top + 1, first);
  const tabBar = heading.filter(line => /^\s*←.*✓ Submit\s*→$/.test(line)).map(line => line.trim()).join(" ");
  const content = heading.filter(line => !/^\s*←.*✓ Submit\s*→$/.test(line));
  const start = content.findIndex(line => line.trim());
  if (start < 0) return null;
  // The optional single-question badge has its own leading space inside Text's padding.
  // Blank lines within the following question are paragraphs, not extra widget headings.
  const badge = !tabBar && /^ {2}\S/.test(content[start]!) && !content[start + 1]?.trim();
  const title = badge ? normalizeText(content[start]!) : "";
  const text = normalizeText(content.slice(start + Number(badge)).join("\n"));
  if (!text) return null;
  const options = rows.slice(0, -1).map(row => ({ label: row.label, description: row.description.length ? normalizeText(row.description.join(" ")) : null }));
  const selectedIndex = next?.selected ? rows.length : rows.findIndex(row => row.selected);
  const checked = rows.slice(0, -1).flatMap((row, index) => row.checked ? [index] : []);
  const custom = rows.length - 1;
  return finishPrompt("pi", {
    kind: "question", title, question: text, body: null, options,
    multi_select: multi, custom_option_index: multi ? null : custom,
  }, {
    responder: "pi-ask-question", menuLabels: [...options.map(option => option.label), OTHER, ...(next ? [next.label] : [])],
    selectedIndex, checkedOptionIndices: checked, customMenuIndex: multi ? null : custom, rejectWithEscapeIndex: null,
    ...(!multi ? { customSteps: (text: string): AnswerStep[] => [
      ...keySteps(navigationKeys(custom - selectedIndex)), ...keySteps(["ctrl+u"]), { text }, ...keySteps([KEY.enter]),
    ] } : { multiSteps: (choices: number[]): AnswerStep[] => {
      const desired = new Set(choices);
      const keys: string[] = [];
      let cursor = selectedIndex;
      for (let index = 0; index < options.length; index += 1) {
        if (desired.has(index) === checked.includes(index)) continue;
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      keys.push(...navigationKeys(rows.length - cursor), KEY.enter);
      return keySteps(keys);
    } }),
  }, { call: JSON.stringify({ tabBar, ...(multi ? { checked } : {}) }) });
}

function review(frame: Frame): ParsedPrompt | null {
  const { lines, top, bottom, hintIndex, hint } = frame;
  if (!lines.slice(top + 1, bottom).some(line => line.trim() === "Review your answers")) return null;
  // Exactly the ready prompt and its two native rows, never the incomplete-answers warning.
  const picker = lines.slice(bottom + 1, hintIndex).filter(line => line.trim());
  if (picker.length !== 3 || picker[0]!.trim() !== "Ready to submit your answers?" || !/n to add a note/.test(hint)) return null;
  const rows = picker.slice(1).map(line => line.match(ROW_RE));
  if (!rows[0] || !rows[1] || rows[0][2] !== "1" || rows[1][2] !== "2"
    || rows[0][3] !== "Submit answers" || rows[1][3] !== "Cancel"
    || rows.filter(row => row![1] === "❯ ").length !== 1) return null;
  const body = lines.slice(top + 1, bottom).map(cleanLine).filter(line => line && !/^←/.test(line) && line !== "Review your answers").join("\n");
  return finishPrompt("pi", {
    kind: "question", title: "Review your answers", question: "Submit these answers?", body: body || null,
    options: [{ label: "Submit answers", description: null }, { label: "Cancel", description: null }],
    multi_select: false, custom_option_index: null,
  }, {
    responder: "pi-ask-submit", menuLabels: ["Submit answers", "Cancel"],
    selectedIndex: rows[0][1] === "❯ " ? 0 : 1, checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
  });
}

export function parsePiAsk(screen: string): ParsedPrompt | null {
  const shown = frame(screen);
  return shown ? question(shown) ?? review(shown) : null;
}

export const readers: readonly DialogReader[] = ["pi-ask-question", "pi-ask-submit"].map(id => ({
  id, agents: ["pi"], priority: 85, reread: "before-commit", list: "none",
  parse: (screen: string) => {
    const parsed = parsePiAsk(screen);
    return parsed?.responder === id ? parsed : null;
  },
}));
