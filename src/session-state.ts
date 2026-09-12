/**
 * Session state management for /btw slots.
 *
 * Manages slot lifecycle: create, switch, queue, clear, restore.
 * Each slot has its own BtwChild (RPC process) and queue chain.
 */

import { BtwChild } from "./btw-child.ts";
import {
  type BtwChildHandle,
  type BtwSlot,
  type BtwSlotState,
  type BtwTurn,
  type BtwUsage,
  MAX_BTW_SLOTS,
} from "./types.ts";

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

/**
 * Index of the first unused slot, or `undefined` when all 9 are taken.
 * Callers must handle the exhausted case instead of letting it become an
 * out-of-range index.
 */
export function freeSlotIndex(state: BtwSlotState): number | undefined {
  for (let i = 0; i < MAX_BTW_SLOTS; i++) {
    if (!state.slots[i]) return i;
  }
  return undefined;
}

function lowestFreeIndex(state: BtwSlotState): number {
  const idx = freeSlotIndex(state);
  if (idx === undefined) {
    throw new Error(`All ${MAX_BTW_SLOTS} BTW slots are in use. Clear one with Alt+X first.`);
  }
  return idx;
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

/** How an answer was produced, so the UI can label degraded results. */
export interface AskOutcome {
  answer?: string;
  usage?: BtwUsage;
  error?: string;
  viaFallback?: boolean;
}

export interface QueueQuestionArgs {
  state: BtwSlotState;
  /** Slot to run in. Defaults to the active slot, creating one if needed. */
  slot?: BtwSlot;
  question: string;
  provider: string;
  modelId: string;
  cwd: string;
  /**
   * Context block for the first turn of a child process. The child keeps its
   * own conversation, so later turns in the same slot do not resend it.
   */
  contextMessage?: string;
  /**
   * Called on every state change so the caller can re-render. The turn is
   * passed in because the caller's binding for it does not exist yet the
   * first time this fires.
   */
  onUpdate?: (turn: BtwTurn) => void;
  /**
   * Used when the RPC child cannot be started or dies mid-answer. Receives the
   * underlying RPC error so the caller can report why it degraded. Returning an
   * answer here marks the turn as `viaFallback`.
   */
  onFallback?: (
    question: string,
    onPartial: (text: string) => void,
    rpcError: string,
  ) => Promise<AskOutcome>;
  /** Persist the settled turn. Failures are swallowed: a stale API is expected. */
  persist?: (slot: BtwSlot, turn: BtwTurn) => void;
  /** Injection point for tests. Defaults to spawning a real BtwChild. */
  createChild?: (
    cwd: string,
    provider: string,
    modelId: string,
    onUpdate: () => void,
  ) => BtwChildHandle;
}

/**
 * Append a question to a slot's serial queue.
 *
 * Questions in the same slot run one at a time against a shared child process;
 * different slots run in parallel. Returns the turn (already visible in
 * `slot.turns`, so the UI can render it while it is still queued) plus a
 * promise that settles when the turn finishes.
 */
export function queueQuestionToSlot(args: QueueQuestionArgs): {
  turn: BtwTurn;
  done: Promise<BtwTurn>;
} {
  const {
    state,
    question,
    provider,
    modelId,
    cwd,
    contextMessage,
    onUpdate,
    onFallback,
    persist,
    createChild,
  } = args;
  const slot = args.slot ?? activeSlot(state) ?? createSlot(state);

  const turn: BtwTurn = {
    question,
    startedAt: Date.now(),
    status: "queued",
    modelId,
  };
  slot.turns.push(turn);
  state.folded = false;
  slot.unread = false;
  onUpdate?.(turn);

  const generation = slot.generation;
  const spawnChild =
    createChild ??
    ((childCwd, childProvider, childModelId, notify) =>
      new BtwChild(childCwd, childProvider, childModelId, notify));

  const done = slot.queue
    .catch(() => undefined)
    .then(async (): Promise<BtwTurn> => {
      // The slot was cleared or replaced while this turn sat in the queue.
      if (slot.generation !== generation) {
        turn.status = "failed";
        turn.error ??= "Slot cleared before this question ran.";
        return turn;
      }

      slot.running = true;
      turn.status = "running";
      turn.turnIndex ??= slot.nextTurnIndex++;
      onUpdate?.(turn);

      const onPartial = (partial: string) => {
        if (slot.generation !== generation) return;
        turn.partial = partial;
        onUpdate?.(turn);
      };

      try {
        let isNewChild = false;
        if (!slot.child) {
          slot.child = spawnChild(cwd, provider, modelId, () => onUpdate?.(turn));
          isNewChild = true;
          await slot.child.ready();
        }

        if (slot.generation !== generation) {
          turn.status = "failed";
          turn.error ??= "Slot cleared while this question was running.";
          return turn;
        }

        // Only the first turn of a child needs the main-session context; after
        // that the child's own history already carries it.
        const sendContext = isNewChild || !slot.contextSent;
        const answer = await slot.child.ask(
          question,
          onPartial,
          sendContext ? contextMessage : undefined,
        );
        if (sendContext && contextMessage) slot.contextSent = true;

        turn.answer = answer || "(no answer)";
        turn.usage = toUsage(slot.child.details.lastAskUsage);
        slot.restored = false;
        turn.status = "answered";
      } catch (error) {
        // Never keep a dead child in the slot: the next question should get a
        // fresh process rather than failing the same way again.
        const failedChild = slot.child;
        // Capture stderr before stopping: it is the only clue for spawn
        // failures, which produce a message with no other detail.
        const stderr = failedChild?.details.stderr.trim() ?? "";
        if (failedChild) {
          slot.child = undefined;
          slot.contextSent = false;
          try { await failedChild.stop(); } catch { /* already closed */ }
        }
        if (slot.generation !== generation) {
          turn.status = "failed";
          turn.error ??= "Slot cleared while this question was running.";
          return turn;
        }

        const message = error instanceof Error ? error.message : String(error);
        // The child folds stderr into its own errors; only append when it is
        // genuinely new information.
        const rpcError = stderr && !message.includes(stderr)
          ? `${message} Stderr: ${stderr}`
          : message;
        if (onFallback) {
          try {
            const outcome = await onFallback(question, onPartial, rpcError);
            if (slot.generation !== generation) {
              turn.status = "failed";
              turn.error ??= "Slot cleared while this question was running.";
              return turn;
            }
            turn.viaFallback = true;
            if (outcome.error) {
              turn.error = outcome.error;
              turn.status = "failed";
            } else {
              turn.answer = outcome.answer || "(no answer)";
              turn.usage = outcome.usage;
              turn.status = "answered";
            }
          } catch (fallbackError) {
            turn.error = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            turn.status = "failed";
          }
        } else {
          turn.error = rpcError;
          turn.status = "failed";
        }
      } finally {
        turn.finishedAt = Date.now();
        delete turn.partial;
        slot.running = false;
        slot.unread = !(state.activeIndex === slot.index && !state.folded);
        onUpdate?.(turn);

        if (turn.answer || turn.error) {
          try {
            persist?.(slot, turn);
          } catch {
            // Stale extension API after a session replacement.
          }
        }
      }
      return turn;
    });

  // The queue chain must survive a failing turn, and it must not surface an
  // unhandled rejection when the caller only cares about `done`.
  slot.queue = done.then(
    () => undefined,
    () => undefined,
  );

  return { turn, done };
}

function toUsage(raw: BtwChildHandle["details"]["lastAskUsage"]): BtwUsage | undefined {
  if (!raw) return undefined;
  if (!raw.input && !raw.output && !raw.cost) return undefined;
  return {
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    totalCost: raw.cost,
  };
}
