/**
 * Session state management for /btw slots.
 *
 * Manages slot lifecycle: create, switch, queue, clear, restore.
 * Each slot has its own BtwChild (RPC process) and queue chain.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BtwChild } from "./btw-child.ts";
import { BtwSlot, BtwSlotState, BtwTurn, MAX_BTW_SLOTS } from "./types.ts";

// ── Initial state ──

export function createInitialState(): BtwSlotState {
  return { slots: [], activeIndex: 0, folded: false };
}

// ── Slot helpers ──

export function activeSlot(state: BtwSlotState): BtwSlot | undefined {
  return state.slots[state.activeIndex];
}

export function listSlots(state: BtwSlotState): BtwSlot[] {
  return state.slots.filter((s): s is BtwSlot => !!s);
}

export function doneTurns(turns: BtwTurn[]): BtwTurn[] {
  return turns.filter((t) => t.answer || t.error);
}

function makeSlot(index: number): BtwSlot {
  return {
    index,
    generationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    nextTurnIndex: 1,
    turns: [],
    running: false,
    unread: false,
    generation: 0,
    queue: Promise.resolve(),
  };
}

function lowestFreeIndex(state: BtwSlotState): number {
  const idx = state.slots.findIndex((s) => !s);
  return idx === -1 ? state.slots.length : idx;
}

// ── Slot CRUD ──

export function createSlot(state: BtwSlotState, index = lowestFreeIndex(state)): BtwSlot {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_BTW_SLOTS) {
    throw new Error(`BTW slot index must be 0-${MAX_BTW_SLOTS - 1}`);
  }
  while (state.slots.length <= index) state.slots.push(undefined);
  const slot = makeSlot(index);
  state.slots[index] = slot;
  state.activeIndex = index;
  state.folded = false;
  return slot;
}

export function ensureSlot(state: BtwSlotState, index: number): BtwSlot {
  if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_BTW_SLOTS) {
    throw new Error(`BTW slot number must be 1-${MAX_BTW_SLOTS}`);
  }
  const existing = state.slots[index];
  const slot = existing ?? createSlot(state, index);
  state.activeIndex = index;
  state.folded = false;
  if (slot) slot.unread = false;
  return slot;
}

export function switchRelativeSlot(state: BtwSlotState, direction: number): boolean {
  const slots = listSlots(state);
  if (slots.length === 0) return false;
  const currentPos = Math.max(
    0,
    slots.findIndex((s) => s.index === state.activeIndex),
  );
  const next = slots[(currentPos + direction + slots.length) % slots.length];
  if (!next) return false;
  state.activeIndex = next.index;
  state.folded = false;
  next.unread = false;
  return true;
}

export async function clearSlot(
  state: BtwSlotState,
  slot: BtwSlot,
  onUpdate?: () => void,
): Promise<void> {
  slot.generation++;
  slot.turns = [];
  slot.running = false;
  slot.unread = false;
  slot.queue = Promise.resolve();
  state.slots[slot.index] = undefined;
  // Select nearest slot
  const slots = listSlots(state);
  if (slots.length > 0) {
    const next =
      slots.find((s) => s.index > slot.index) ??
      slots[slots.length - 1]!;
    state.activeIndex = next.index;
  } else {
    state.activeIndex = 0;
  }
  const child = slot.child;
  delete slot.child;
  await child?.stop();
  onUpdate?.();
}

// ── Restore from session entries ──

export function restoreStateFromMessages(
  state: BtwSlotState,
  messages: { customType?: string; details?: unknown }[],
): void {
  // Simplified restore: rebuild slots from btw-entry messages
  // Each entry with a slot number creates/restores a slot
  for (const msg of messages) {
    const details = msg.details as Record<string, unknown> | undefined;
    if (!details || typeof details.slot !== "number") continue;
    const idx = details.slot as number;
    if (idx < 0 || idx >= MAX_BTW_SLOTS) continue;

    let slot = state.slots[idx];
    if (!slot) {
      slot = makeSlot(idx);
      while (state.slots.length <= idx) state.slots.push(undefined);
      state.slots[idx] = slot;
    }

    const turn: BtwTurn = {
      question: String(details.question ?? ""),
      answer: typeof details.answer === "string" ? details.answer : undefined,
      error: typeof details.error === "string" ? details.error : undefined,
      startedAt: typeof details.startedAt === "number" ? details.startedAt : Date.now(),
      finishedAt: typeof details.finishedAt === "number" ? details.finishedAt : undefined,
      status: details.error ? "failed" : "answered",
      turnIndex: typeof details.turn === "number" ? details.turn : slot.nextTurnIndex++,
    };
    slot.turns.push(turn);

    if (!state.slots[state.activeIndex]) state.activeIndex = idx;
  }
}

export function slotStatus(slot: BtwSlot): string {
  if (slot.running || slot.turns.some((t) => t.status === "queued" || t.status === "running"))
    return "running";
  if (slot.unread) return "unread";
  if (slot.turns.some((t) => t.error)) return "failed";
  if (doneTurns(slot.turns).length > 0) return "answered";
  return "ready";
}

// ── Parse /btw args ──

const NUMBERED_SLOT_PATTERN = /^(\d+)\s*(.*)$/;

export function parseBtwArgs(args: string): {
  slotNumber?: number;
  question: string;
} {
  const trimmed = args.trim();
  if (!trimmed) return { slotNumber: undefined, question: "" };
  const match = trimmed.match(NUMBERED_SLOT_PATTERN);
  if (!match) return { slotNumber: undefined, question: trimmed };
  const num = parseInt(match[1]!, 10);
  if (num < 1 || num > MAX_BTW_SLOTS) return { slotNumber: undefined, question: trimmed };
  return {
    slotNumber: num,
    question: match[2]?.trim() ?? "",
  };
}

// ── Injection output formatting ──

export function injectionText(turns: BtwTurn[]): string {
  const completed = doneTurns(turns);
  if (completed.length === 1) {
    const t = completed[0]!;
    return [
      "[BTW Answer Injection]",
      "The user asked the following question in a separate session:",
      t.question,
      "The answer was:",
      t.answer || t.error || "(no answer)",
      "Take it into account while executing the current task.",
    ].join("\n");
  }
  return [
    "[BTW Answer Injection]",
    "The user asked the following questions in a separate session:",
    ...completed.flatMap((t, i) => [
      "",
      `Question ${i + 1}:`,
      t.question,
      "Answer:",
      t.answer || t.error || "(no answer)",
    ]),
    "",
    "Take them into account while executing the current task.",
  ].join("\n");
}

// ── Queue question to a slot ──

export function queueQuestionToSlot(args: {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  question: string;
  state: BtwSlotState;
  provider: string;
  modelId: string;
  onRender?: (ctx: ExtensionContext, state: BtwSlotState) => void;
}): void {
  const { ctx, pi, question, state, provider, modelId, onRender } = args;
  const slot = activeSlot(state) ?? createSlot(state);

  const turn: BtwTurn = {
    question,
    startedAt: Date.now(),
    status: "queued",
  };
  slot.turns.push(turn);
  state.folded = false;
  slot.unread = false;
  onRender?.(ctx, state);

  const generation = slot.generation;

  slot.queue = slot.queue
    .catch(() => undefined)
    .then(async () => {
      // Skip if generation changed while queued
      if (slot.generation !== generation) return;

      slot.running = true;
      turn.status = "running";
      turn.turnIndex ??= slot.nextTurnIndex++;
      onRender?.(ctx, state);

      try {
        if (!slot.child) {
          slot.child = new BtwChild(ctx.cwd, provider, modelId, () => onRender?.(ctx, state));
          await slot.child.ready();
        }

        if (slot.generation !== generation) return;

        turn.answer = await slot.child.ask(question, (partial) => {
          turn.partial = partial;
          onRender?.(ctx, state);
        }) || "(no answer)";

        slot.restored = false;
        delete turn.partial;
        turn.status = "answered";
      } catch (error) {
        if (slot.generation !== generation) return;
        turn.error = error instanceof Error ? error.message : String(error);
        turn.status = "failed";
      } finally {
        turn.finishedAt = Date.now();
        slot.running = false;
        slot.unread = !(state.activeIndex === slot.index && !state.folded);
        onRender?.(ctx, state);

        // Persist turn result
        if (turn.answer || turn.error) {
          try {
            pi.appendEntry("btw-entry", {
              kind: "result",
              slot: slot.index + 1,
              generation: slot.generationId,
              turn: turn.turnIndex,
              question: turn.question,
              answer: turn.answer,
              error: turn.error,
              startedAt: turn.startedAt,
              finishedAt: turn.finishedAt,
            });
          } catch {
            // stale api
          }
        }
      }
    });
}
