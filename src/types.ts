/**
 * Shared types for the /btw RPC child + slot system.
 */

import type { Message } from "@earendil-works/pi-ai";

// ────────────────────────────────────────────────────────────────
// Usage & Entry Types
// ────────────────────────────────────────────────────────────────

export interface BtwUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
}

export interface BtwEntry {
  id: string;
  question: string;
  answer: string;
  modelProvider: string;
  modelId: string;
  timestamp: number;
  usage?: BtwUsage;
  error?: string;
}

// ────────────────────────────────────────────────────────────────
// Slot & Session Types
// ────────────────────────────────────────────────────────────────

export const MAX_BTW_SLOTS = 9;

export interface BtwTurn {
  question: string;
  answer?: string;
  error?: string;
  partial?: string;
  startedAt: number;
  finishedAt?: number;
  status?: "queued" | "running" | "answered" | "failed";
  turnIndex?: number;
}

export interface BtwSlot {
  index: number;
  generationId: string;
  nextTurnIndex: number;
  child?: BtwChildHandle | undefined;
  turns: BtwTurn[];
  running: boolean;
  unread: boolean;
  generation: number;
  queue: Promise<void>;
  restored?: boolean;
}

export interface BtwSlotState {
  slots: (BtwSlot | undefined)[];
  activeIndex: number;
  folded: boolean;
}

// ────────────────────────────────────────────────────────────────
// RPC Child Types
// ────────────────────────────────────────────────────────────────

export interface BtwChildHandle {
  readonly details: ChildDetails;
  ready(): Promise<void>;
  ask(
    question: string,
    onPartial?: (text: string) => void,
    contextMessage?: string,
  ): Promise<string>;
  stop(): Promise<void>;
}

export interface ChildDetails {
  cwd: string;
  provider: string;
  modelId: string;
  messages: Message[];
  stderr: string;
  usage: {
    turns: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
  };
  stopReason?: string;
  errorMessage?: string;
}

// ────────────────────────────────────────────────────────────────
// Config Types
// ────────────────────────────────────────────────────────────────

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface BtwChildConfig {
  provider: string;
  modelId: string;
  command?: string;
  thinking?: ThinkingLevel;
}

// ────────────────────────────────────────────────────────────────
// RPC Protocol Types
// ────────────────────────────────────────────────────────────────

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface MessageUpdateEvent extends RpcEvent {
  type: "message_update";
  message?: unknown;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    partial?: unknown;
  };
}

export interface AgentSettledEvent extends RpcEvent {
  type: "agent_settled";
}

export interface MessageEndEvent extends RpcEvent {
  type: "message_end";
  message?: unknown;
}

export interface TurnEndEvent extends RpcEvent {
  type: "turn_end";
  message?: unknown;
  toolResults?: unknown[];
}
