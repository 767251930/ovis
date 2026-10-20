import { readers } from "./index.ts";
import { claudeModelListWaits, CLAUDE_EFFORT_GUARD_RE } from "./claude.ts";
import { codexModelListWaits } from "./codex.ts";
import type { OmoAsk, ParsedPrompt } from "./shared.ts";
import type { InteractionPlan } from "./interaction-plan.ts";

export interface ReaderContext {
  agent: string;
  omoAsk: OmoAsk | null;
  omoTrusted: boolean;
  omoOpen: OmoAsk[];
  sent: string | null;
  working: boolean;
  /** Fallback cards are read only after the caller knows the pane is blocked. */
  fallback?: boolean;
}

export interface DialogReader {
  id: string;
  agents: readonly string[];
  priority: number;
  parse(screen: string, ctx: ReaderContext): ParsedPrompt | null;
  /**
   * When the answer looks at the screen again: before its commit, or also before every move after
   * the first, for a picker that closes onto an input box where the remaining arrows would land
   */
  reread: "each-move" | "before-commit" | "none";
  list: "none" | "letter-window" | "slider";
  interaction?(parsed: ParsedPrompt): InteractionPlan;
}

export function readersFor(agent: string): readonly DialogReader[] {
  return readers.filter((reader) => reader.agents.includes(agent) || reader.agents.includes("*")).sort((a, b) => a.priority - b.priority);
}

export const registry = {
  readersFor,
  readerFor(responder: string): DialogReader | undefined {
    return readers.find((reader) => reader.id === responder);
  },
  waits(agent: string, screen: string): boolean {
    return claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE) || (agent === "codex" && codexModelListWaits(screen));
  },
};
