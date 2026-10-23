import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { handlePromptRequest, promptWaitEnded } from "../prompt.ts";
import { socketAddress } from "../herdr/client.ts";
import fixtures from "./fixtures/pi-ask-2.13.9.json";

// A fake RPC endpoint on a unique pipe/socket. Never connects to a real Herdr session.
async function withPane(initial: string, run: (pane: {
  screen: string; status: string; sent: string[]; onSent?: (key: string) => void;
  card(): Promise<InteractivePrompt>; read(): Promise<InteractivePrompt | null>;
  answer(id: string, choice: object, signal?: AbortSignal): Promise<number>;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ovis-pi-ask-"));
  const endpoint = socketAddress(join(root, "herdr.sock"));
  const id = `pi-ask-${randomUUID()}`;
  const sockets = new Set<Socket>();
  const readCard = async (): Promise<InteractivePrompt | null> => {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${id}`);
    const response = (await handlePromptRequest(new Request(url), url))!;
    expect(response.status).toBe(200);
    return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
  };
  const pane = {
    screen: initial, status: "blocked", sent: [] as string[], onSent: undefined as ((key: string) => void) | undefined,
    read: readCard,
    card: async () => {
      const prompt = await readCard();
      expect(prompt).not.toBeNull();
      return prompt!;
    },
    answer: async (prompt: string, choice: object, signal?: AbortSignal) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, {
        method: "POST", signal, body: JSON.stringify({ pane_id: id, prompt_id: prompt, ...choice }),
      }), url))!;
      return response.status;
    },
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const reply = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.method === "session.snapshot") return reply({ snapshot: { panes: [{ pane_id: id, agent: "pi", agent_status: pane.status, terminal_id: id }], layouts: [] } });
      if (request.method === "pane.read") return reply({ read: { text: pane.screen } });
      if (request.method === "pane.process_info") return reply({ process_info: { foreground_processes: [] } });
      if (request.method === "agent.get") return reply({ agent: {} });
      if (request.method === "pane.send_keys" || request.method === "pane.send_text") {
        for (const key of request.params.keys ?? [`text:${request.params.text}`]) {
          pane.sent.push(key);
          pane.onSent?.(key);
        }
        return reply({});
      }
      socket.end(JSON.stringify({ id: request.id, error: { code: "unexpected_fixture_rpc", message: "Unexpected test RPC" } }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = endpoint;
  try { await run(pane); } finally {
    promptWaitEnded(id);
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test("Pi ask answer route confirms the real second choice after observing its cursor", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    expect(card).not.toBeNull();
    expect(card.options[1]!.label).toBe("只允许普通单值");
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["single-second"]; };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["down", "enter"]);
  });
});

test("Pi ask answer route refuses a question replaced during navigation", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["single-second"].replace("结果表是否允许结构化单元格？", "A different question?"); };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(409);
    expect(pane.sent).toEqual(["down"]);
  });
}, 4_000);

test("Pi ask answer route writes a custom answer only after focusing the inline input", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    let moves = 0;
    pane.onSent = key => { if (key === "down") pane.screen = ++moves === 1 ? fixtures["single-second"] : fixtures["single-custom-empty"]; };
    expect(await pane.answer(card.id, { custom_text: "typed answer" })).toBe(200);
    expect(pane.sent).toEqual(["down", "down", "ctrl+u", "text:typed answer", "enter"]);
  });
});

test("Pi ask answer route toggles a multi-pick and commits only its Submit row", async () => {
  await withPane(fixtures.multi, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_indices: [0, 1] })).toBe(200);
    expect(pane.sent).toEqual(["space", "down", "space", "down", "down", "enter"]);
  });
});

test("Pi ask answer route keeps the final review explicit and observes its Cancel cursor", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "down") pane.screen = fixtures["review-cancel"]; };
    expect(await pane.answer(card.id, { option_index: 1 })).toBe(200);
    expect(pane.sent).toEqual(["down", "enter"]);
  });
});

const closingScreen = "Question complete\nEnter to select · ↑/↓ to navigate · Esc to cancel";

test.each([fixtures.single, fixtures.multi, fixtures.review])("Pi ask successful answer does not flash fallback keys while blocked status catches up %#", async screen => {
  await withPane(screen, async pane => {
    const card = await pane.card();
    // The widget has closed, but its hint and the preceding blocked snapshot can outlive it.
    pane.onSent = key => { if (key === "enter") pane.screen = closingScreen; };
    const choice = card.multi_select ? { option_indices: [0] } : { option_index: 0 };
    expect(await pane.answer(card.id, choice)).toBe(200);
    expect(await pane.read()).toBeNull();
  });
});

test("Pi ask closing screen needs no fallback once Herdr reports working", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") { pane.screen = closingScreen; pane.status = "working"; } };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(await pane.read()).toBeNull();
  });
});

test("Pi ask settling does not delay a recognized next question", async () => {
  await withPane(fixtures["tabs-first"], async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") pane.screen = fixtures["tabs-second"]; };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    const next = await pane.card();
    expect(next.fallback).not.toBe(true);
    expect(next.id).not.toBe(card.id);
    expect(next.question).not.toBe(card.question);
  });
});

test("Pi ask does not suppress fallback without a successful answer", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_index: 99 })).toBe(400);
    pane.screen = closingScreen;
    const unknown = await pane.card();
    expect(unknown.fallback).toBe(true);
    expect(unknown.options.map(option => option.label)).toEqual(["↑", "↓", "Enter", "Esc"]);
  });
});

test("Pi ask fallback protection expires instead of hiding a persistent unknown blocker", async () => {
  await withPane(fixtures.review, async pane => {
    const card = await pane.card();
    pane.onSent = key => { if (key === "enter") pane.screen = closingScreen; };
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(200);
    expect(await pane.read()).toBeNull();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 4_000);
    try { expect((await pane.card()).fallback).toBe(true); }
    finally { clock.mockRestore(); }
  });
});

test("Pi ask answer route sends no input for invalid, stale or cancelled answers", async () => {
  await withPane(fixtures.single, async pane => {
    const card = await pane.card();
    expect(await pane.answer(card.id, { option_index: 99 })).toBe(400);
    const abort = new AbortController(); abort.abort();
    expect(await pane.answer(card.id, { option_index: 0 }, abort.signal)).toBe(409);
    pane.screen = "Working…";
    expect(await pane.answer(card.id, { option_index: 0 })).toBe(409);
    expect(pane.sent).toEqual([]);
  });
});
