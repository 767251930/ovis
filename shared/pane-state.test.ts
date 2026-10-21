import { expect, it } from "bun:test";
import { LOCAL_MACHINE, paneStateStorageId, paneStorageId, parsePaneStateStorageId } from "./machines.ts";

it("encodes each PC, pane and herdr lifetime as its own collision-free tuple", () => {
  const tuples: [string, string, string][] = [
    [LOCAL_MACHINE, "w1:p1", "a"], [LOCAL_MACHINE, "w1:p1", "b"], ["remote", "w1:p1", "a"],
    // separators and escapes inside a part never make two tuples meet
    [LOCAL_MACHINE, "w1", "a:p1"], ["local:w1", "p1", "a"], ["a", "b:c", "d"], ["a:b", "c", "d"],
    ["%3A", "p", "l"], [":", "p", "l"], ["pc", "p%", "l"], ["pc", "p", "l%253A"], ["pc", "p", "l%3A"],
  ];
  const keys = tuples.map(([machine, pane, lifetime]) => paneStateStorageId(machine, pane, lifetime));
  expect(new Set(keys).size).toBe(tuples.length);
  for (const [index, [machine, pane, lifetime]] of tuples.entries()) {
    expect(parsePaneStateStorageId(keys[index]!)).toEqual({ lifetime, machine_id: machine, pane_id: pane });
  }
});

it("never reads a pre-lifetime key, or anything malformed, as a lifetime tuple", () => {
  for (const legacy of [paneStorageId(LOCAL_MACHINE, "w1:p1"), paneStorageId("remote", "w1:p1"), "pane-state:v1", "pane-state:v1:a:b", "pane-state:v1:a:b:c:d", "pane-state:v2:a:b:c", "pane-state:v1:%E0%A4%A:b:c", "pane-state:v1::b:c"]) {
    expect(parsePaneStateStorageId(legacy)).toBeNull();
  }
  // nor does a lifetime key collide with what paneStorageId gives any PC and pane
  expect(paneStateStorageId(LOCAL_MACHINE, "w1:p1", "a")).not.toBe(paneStorageId(LOCAL_MACHINE, "w1:p1"));
  expect(paneStateStorageId(LOCAL_MACHINE, "w1:p1", "a").startsWith("remote:")).toBe(false);
});
