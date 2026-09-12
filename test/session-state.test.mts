import test from "node:test";
import assert from "node:assert/strict";
import {
  activeSlot,
  clearSlot,
  createInitialState,
  createSlot,
  ensureSlot,
  freeSlotIndex,
  injectionText,
  listSlots,
  parseBtwArgs,
  queueQuestionToSlot,
  restoreStateFromMessages,
  switchRelativeSlot,
} from "../src/session-state.ts";
import { MAX_BTW_SLOTS, type BtwChildHandle, type BtwSlotState } from "../src/types.ts";

// ── Argument parsing ──

test("parseBtwArgs splits a leading slot number from the question", () => {
  assert.deepEqual(parseBtwArgs("2 why is this slow"), { slotNumber: 2, question: "why is this slow" });
  assert.deepEqual(parseBtwArgs("3"), { slotNumber: 3, question: "" });
  assert.deepEqual(parseBtwArgs(""), { slotNumber: undefined, question: "" });
});

test("parseBtwArgs treats out-of-range and non-leading numbers as part of the question", () => {
  assert.deepEqual(parseBtwArgs("42 is the answer"), {
    slotNumber: undefined,
    question: "42 is the answer",
  });
  assert.deepEqual(parseBtwArgs("0 nope"), { slotNumber: undefined, question: "0 nope" });
  assert.deepEqual(parseBtwArgs("what is 2 + 2"), {
    slotNumber: undefined,
    question: "what is 2 + 2",
  });
});

// ── Slot allocation ──

test("freeSlotIndex reports exhaustion instead of an out-of-range index", () => {
  const state = createInitialState();
  assert.equal(freeSlotIndex(state), 0);

  for (let i = 0; i < MAX_BTW_SLOTS; i++) {
    createSlot(state, i);
    const expected = i + 1 < MAX_BTW_SLOTS ? i + 1 : undefined;
    assert.equal(freeSlotIndex(state), expected, `after filling slot ${i}`);
  }

  // Regression: this used to hand MAX_BTW_SLOTS to ensureSlot, which threw.
  assert.equal(freeSlotIndex(state), undefined);
});

test("freeSlotIndex reuses a hole left by a cleared slot", async () => {
  const state = createInitialState();
  createSlot(state, 0);
  createSlot(state, 1);
  assert.equal(freeSlotIndex(state), 2);

  await clearSlot(state, state.slots[0]!);
  assert.equal(freeSlotIndex(state), 0);
});

test("ensureSlot rejects slot numbers outside 1-9", () => {
  const state = createInitialState();
  assert.throws(() => ensureSlot(state, -1), /slot number must be 1-9/);
  assert.throws(() => ensureSlot(state, MAX_BTW_SLOTS), /slot number must be 1-9/);
  assert.throws(() => ensureSlot(state, 1.5), /slot number must be 1-9/);
});

test("ensureSlot is idempotent and activates the slot", () => {
  const state = createInitialState();
  const first = ensureSlot(state, 4);
  first.unread = true;
  const again = ensureSlot(state, 4);
  assert.equal(again, first, "must not replace an existing slot");
  assert.equal(state.activeIndex, 4);
  assert.equal(again.unread, false);
});

test("switchRelativeSlot cycles through occupied slots only", () => {
  const state = createInitialState();
  assert.equal(switchRelativeSlot(state, 1), false, "no slots to switch between");

  createSlot(state, 0);
  createSlot(state, 3);
  createSlot(state, 7);
  state.activeIndex = 0;

  assert.equal(switchRelativeSlot(state, 1), true);
  assert.equal(state.activeIndex, 3);
  assert.equal(switchRelativeSlot(state, 1), true);
  assert.equal(state.activeIndex, 7);
  assert.equal(switchRelativeSlot(state, 1), true);
  assert.equal(state.activeIndex, 0, "wraps around");
  assert.equal(switchRelativeSlot(state, -1), true);
  assert.equal(state.activeIndex, 7, "wraps backwards");
});

test("clearSlot stops the child and picks a neighbouring slot", async () => {
  const state = createInitialState();
  createSlot(state, 0);
  createSlot(state, 1);
  let stopped = false;
  state.slots[0]!.child = makeFakeChild({ onStop: () => { stopped = true; } });

  await clearSlot(state, state.slots[0]!);

  assert.equal(stopped, true, "child process must be stopped");
  assert.equal(state.slots[0], undefined);
  assert.equal(state.activeIndex, 1);
  assert.equal(listSlots(state).length, 1);
});

// ── Injection formatting ──

test("injectionText renders a single answer", () => {
  const text = injectionText([
    { question: "why?", answer: "because", startedAt: 0, status: "answered" },
  ]);
  assert.match(text, /^\[BTW Answer Injection\]/);
  assert.match(text, /why\?/);
  assert.match(text, /because/);
});

test("injectionText numbers multiple answers and falls back to errors", () => {
  const text = injectionText([
    { question: "q1", answer: "a1", startedAt: 0, status: "answered" },
    { question: "q2", error: "boom", startedAt: 0, status: "failed" },
    { question: "pending", startedAt: 0, status: "running" },
  ]);
  assert.match(text, /Question 1:/);
  assert.match(text, /Question 2:/);
  assert.doesNotMatch(text, /Question 3:/, "unsettled turns must be skipped");
  assert.match(text, /boom/);
});

// ── Restore ──

test("restoreStateFromMessages rebuilds slots from persisted turns", () => {
  const state = createInitialState();
  restoreStateFromMessages(state, [
    {
      customType: "btw-entry",
      details: { slot: 0, turn: 1, question: "q1", answer: "a1", startedAt: 1, finishedAt: 2 },
    },
    {
      customType: "btw-entry",
      details: { slot: 2, turn: 1, question: "q2", error: "nope", startedAt: 3, finishedAt: 4 },
    },
    { customType: "btw-entry", details: { question: "no slot field" } },
    { customType: "btw-entry", details: { slot: 99, question: "out of range" } },
  ]);

  assert.equal(listSlots(state).length, 2);
  assert.equal(state.slots[0]!.turns[0]!.answer, "a1");
  assert.equal(state.slots[0]!.turns[0]!.status, "answered");
  assert.equal(state.slots[2]!.turns[0]!.error, "nope");
  assert.equal(state.slots[2]!.turns[0]!.status, "failed");
});

// ── Queue engine ──

interface FakeChildOptions {
  answer?: string;
  readyError?: Error;
  askError?: Error;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  onStop?: () => void;
}

function makeFakeChild(options: FakeChildOptions = {}): BtwChildHandle {
  const child: BtwChildHandle = {
    details: {
      cwd: ".",
      provider: "p",
      modelId: "m",
      messages: [],
      stderr: "",
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
    },
    async ready() {
      if (options.readyError) throw options.readyError;
    },
    async ask(_question, onPartial, contextMessage) {
      askCalls.push({ context: contextMessage });
      onPartial?.("partial…");
      if (options.askError) throw options.askError;
      child.details.lastAskUsage = options.usage ?? {
        input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5,
      };
      return options.answer ?? "the answer";
    },
    async abort() {},
    async stop() { options.onStop?.(); },
  };
  return child;
}

const askCalls: { context: string | undefined }[] = [];

function baseArgs(state: BtwSlotState, overrides: Record<string, unknown> = {}) {
  return {
    state,
    question: "why?",
    provider: "p",
    modelId: "m",
    cwd: ".",
    createChild: () => makeFakeChild(),
    ...overrides,
  } as Parameters<typeof queueQuestionToSlot>[0];
}

test("queueQuestionToSlot records the answer, usage, and turn on the slot", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);

  const { turn, done } = queueQuestionToSlot(baseArgs(state, { slot }));

  assert.equal(slot.turns.length, 1, "turn must be visible while still queued");
  assert.equal(turn.status, "queued");

  await done;

  assert.equal(turn.status, "answered");
  assert.equal(turn.answer, "the answer");
  assert.equal(turn.usage?.output, 20);
  assert.equal(turn.usage?.totalCost, 0.5);
  assert.equal(turn.partial, undefined, "streaming text must be cleared once settled");
  assert.equal(slot.running, false);
  assert.equal(slot.turns[0], turn, "the turn stays on the slot for /btw inject");
});

test("queueQuestionToSlot sends context once per child, not once per question", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);
  const args = baseArgs(state, { slot, contextMessage: "CTX" });

  await queueQuestionToSlot(args).done;
  await queueQuestionToSlot(args).done;

  assert.equal(askCalls.length, 2);
  assert.equal(askCalls[0]!.context, "CTX", "first turn carries the context");
  assert.equal(askCalls[1]!.context, undefined, "child already has it in its own history");
});

test("queueQuestionToSlot serialises turns within one slot", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);
  const order: string[] = [];

  const slowChild: BtwChildHandle = {
    ...makeFakeChild(),
    async ask(question) {
      order.push(`start:${question}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${question}`);
      return `answer:${question}`;
    },
  };

  const args = { ...baseArgs(state, { slot }), createChild: () => slowChild };
  const first = queueQuestionToSlot({ ...args, question: "one" });
  const second = queueQuestionToSlot({ ...args, question: "two" });

  await Promise.all([first.done, second.done]);

  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
  assert.equal(slot.turns.length, 2);
});

test("queueQuestionToSlot drops the dead child and uses the fallback", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);
  let stopped = false;

  const { turn, done } = queueQuestionToSlot(
    baseArgs(state, {
      slot,
      createChild: () =>
        makeFakeChild({ readyError: new Error("child exited"), onStop: () => { stopped = true; } }),
      onFallback: async () => ({ answer: "inline answer" }),
    }),
  );

  await done;

  assert.equal(turn.status, "answered");
  assert.equal(turn.answer, "inline answer");
  assert.equal(turn.viaFallback, true);
  assert.equal(stopped, true, "the broken child must be stopped");
  assert.equal(slot.child, undefined, "next question should spawn a fresh child");
});

test("queueQuestionToSlot surfaces the RPC error when there is no fallback", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);

  const { turn, done } = queueQuestionToSlot(
    baseArgs(state, {
      slot,
      createChild: () => makeFakeChild({ askError: new Error("boom") }),
    }),
  );

  await done;

  assert.equal(turn.status, "failed");
  assert.match(turn.error ?? "", /boom/);
});

test("queueQuestionToSlot abandons a turn whose slot was cleared", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);

  const { turn, done } = queueQuestionToSlot(baseArgs(state, { slot }));
  slot.generation++; // what clearSlot does

  await done;

  assert.equal(turn.status, "failed");
  assert.match(turn.error ?? "", /Slot cleared/);
});

test("a failed turn does not poison the slot queue", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);

  await queueQuestionToSlot(
    baseArgs(state, { slot, createChild: () => makeFakeChild({ askError: new Error("boom") }) }),
  ).done;

  const { turn, done } = queueQuestionToSlot(baseArgs(state, { slot }));
  await done;

  assert.equal(turn.status, "answered", "the next question must still run");
});

test("queueQuestionToSlot persists settled turns for /resume", async () => {
  askCalls.length = 0;
  const state = createInitialState();
  const slot = createSlot(state, 0);
  const persisted: { slotIndex: number; question: string; answer?: string }[] = [];

  await queueQuestionToSlot(
    baseArgs(state, {
      slot,
      persist: (persistedSlot: { index: number }, persistedTurn: { question: string; answer?: string }) => {
        persisted.push({
          slotIndex: persistedSlot.index,
          question: persistedTurn.question,
          answer: persistedTurn.answer,
        });
      },
    }),
  ).done;

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]!.slotIndex, 0);
  assert.equal(persisted[0]!.answer, "the answer");

  // Round-trip: the persisted shape must be restorable.
  const restored = createInitialState();
  restoreStateFromMessages(restored, [
    { customType: "btw-entry", details: { slot: 0, turn: 1, question: "why?", answer: "the answer" } },
  ]);
  assert.equal(activeSlot(restored)?.turns[0]?.answer, "the answer");
});
