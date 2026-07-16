/**
 * BtwChild — RPC child process for /btw
 *
 * Spawns `pi --mode rpc --no-session --model <provider/model>` and
 * communicates via JSONL over stdin/stdout.
 *
 * Based on the pi-smart-btw architecture:
 *   https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-smart-btw
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import type { BtwChildHandle, ChildDetails, RpcEvent } from "./types.ts";

// ── Defaults ──

const READY_TIMEOUT = 15_000;     // 15s for child to become ready
const RESPONSE_TIMEOUT = 120_000; // 2min for a response
const SHUTDOWN_GRACE = 2_000;     // 2s grace before SIGKILL

/**
 * Extract partial text from a streaming assistant message.
 * More lenient than getFinalOutput — shows thinking/reasoning content too.
 */
function getPartialText(msg: Message): string {
  const content = (msg as unknown as Record<string, unknown>).content;
  if (typeof content === "string") return (content as string).trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const p = part as any;
      if (p.type === "text" && typeof p.text === "string") {
        const t = p.text as string;
        if (t.trim()) parts.push(t);
      }
      if (p.type === "thinking" && typeof p.thinking === "string") {
        const t = p.thinking as string;
        if (t.trim()) parts.push(t);
      }
      if ((p.type === "reasoning" || p.type === "reasoningContent") &&
          typeof (p.reasoning ?? p.reasoningContent) === "string") {
        const t = String(p.reasoning ?? p.reasoningContent);
        if (t.trim()) parts.push(t);
      }
    }
    return parts.join("\n\n");
  }
  return "";
}

/** Get the final assistant text from a list of messages */
function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const rawMsg = m as any;
    const content = rawMsg.content;

    // Case 1: content is a plain string
    if (typeof content === "string") {
      if (content.trim()) return content.trim();
      continue;
    }

    // Case 2: content is an array of content parts
    if (Array.isArray(content)) {
      let textParts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as any;
        // Standard text content
        if (p.type === "text" && typeof p.text === "string") {
          if (p.text.trim()) textParts.push(p.text);
        }
        // DeepSeek / reasoning thinking content
        if (p.type === "thinking" && typeof p.thinking === "string") {
          if (p.thinking.trim()) textParts.push(p.thinking);
        }
        // Some providers use 'reasoning' or 'reasoningContent'
        if ((p.type === "reasoning" || p.type === "reasoningContent") && typeof (p.reasoning ?? p.reasoningContent) === "string") {
          const t = String(p.reasoning ?? p.reasoningContent);
          if (t.trim()) textParts.push(t);
        }
      }
      // If we found any text parts, join them. For final messages,
      // prefer the LAST text part (the actual answer, not the thinking).
      if (textParts.length > 0) {
        // Return the last non-thinking text part, or all joined if only thinking
        const lastText = textParts[textParts.length - 1]!;
        return lastText;
      }
    }
  }
  return "";
}

/**
 * Manages a headless pi RPC child process for answering /btw questions.
 * Each child runs independently from the main agent — zero context overhead.
 */
export class BtwChild implements BtwChildHandle {
  readonly details: ChildDetails;
  private proc: ChildProcessWithoutNullStreams;
  private requestId = 0;
  private stdoutBuffer = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  private settledCount = 0;
  private settleWaiters = new Set<{
    after: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private currentPartial = "";
  private onPartial: ((text: string) => void) | undefined;
  private closed = false;
  private exitCode: number | undefined;
  private readonly onUpdate: (() => void) | undefined;

  constructor(cwd: string, provider: string, modelId: string, onUpdate?: () => void) {
    this.onUpdate = onUpdate;

    const childArgs = ["--mode", "rpc", "--no-session", "--model", `${provider}/${modelId}`];

    this.details = {
      cwd,
      provider,
      modelId,
      messages: [],
      stderr: "",
      usage: {
        turns: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
      },
    };

    this.proc = spawn("pi", childArgs, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_BTW_CHILD: "1" },
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.details.stderr += chunk.toString();
      this.onUpdate?.();
    });
    this.proc.on("close", (code: number | null) => {
      this.closed = true;
      this.exitCode = code ?? 0;
      this.flushStdout();
      const error = new Error(`btw child exited with code ${this.exitCode}`);
      this.rejectAll(error);
      this.rejectSettlementWaiters(error);
    });
    this.proc.on("error", (err: Error) => {
      const processError = err instanceof Error ? err : new Error(String(err));
      this.rejectAll(processError);
      this.rejectSettlementWaiters(processError);
    });
  }

  // ── Public API ──

  async ready(): Promise<void> {
    await this.send({ type: "get_state" }, READY_TIMEOUT);
    await this.send({ type: "set_auto_compaction", enabled: true });
    await this.send({ type: "set_auto_retry", enabled: true });
  }

  async ask(
    question: string,
    onPartial?: (text: string) => void,
    contextMessage?: string,
  ): Promise<string> {
    const before = this.settledCount;
    const beforeMessages = this.details.messages.length;
    this.currentPartial = "";
    this.onPartial = onPartial;

    try {
      const messageText = contextMessage ?? [
        "Answer the user's question directly.",
        "Be concise unless the question requires detail.",
        `Question: ${question}`,
      ].join("\n\n");

      await this.send({
        type: "prompt",
        message: messageText,
        streamingBehavior: "followUp",
      });

      await this.waitForSettlement(before);
      return (
        getFinalOutput(this.details.messages.slice(beforeMessages)) ||
        this.currentPartial
      ).trim();
    } finally {
      this.onPartial = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.proc.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.proc.once("close", () => resolve())),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE)).then(() => {
        if (!this.closed) this.proc.kill("SIGKILL");
      }),
    ]);
  }

  // ── Internal: Settlement waiting ──

  private waitForSettlement(after: number): Promise<void> {
    if (this.settledCount > after) return Promise.resolve();
    if (this.closed) {
      return Promise.reject(
        new Error(
          `btw child closed.${this.details.stderr ? ` Stderr: ${this.details.stderr.trim()}` : ""}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.settleWaiters.add({ after, resolve, reject });
    });
  }

  // ── Internal: JSONL send ──

  private send<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs = RESPONSE_TIMEOUT,
  ): Promise<T> {
    if (this.closed || !this.proc.stdin.writable)
      throw new Error("btw child RPC is not available");
    const id = `req_${++this.requestId}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${String(command["type"])}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timeout,
      });
      this.proc.stdin.write(
        JSON.stringify({ ...command, id }) + "\n",
        (err: Error | null | undefined) => {
          if (!err) return;
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  // ── Internal: stdout processing ──

  private onStdout(chunk: Buffer) {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }

  private flushStdout() {
    this.stdoutBuffer += this.stdoutDecoder.end();
    if (this.stdoutBuffer.trim()) {
      this.handleLine(
        this.stdoutBuffer.endsWith("\r")
          ? this.stdoutBuffer.slice(0, -1)
          : this.stdoutBuffer,
      );
    }
    this.stdoutBuffer = "";
  }

  private handleLine(line: string) {
    if (!line.trim()) return;
    let data: RpcEvent;
    try {
      data = JSON.parse(line) as RpcEvent;
    } catch {
      return; // skip malformed JSON
    }
    if (this.handleResponse(data)) return;
    if (data.type === "agent_settled") this.handleAgentSettled();
    if (data.type === "message_end" && data.message)
      this.handleMessageEnd(data.message as Message);
    if (data.type === "message_update") this.handleMessageUpdate(data);
  }

  private handleResponse(data: RpcEvent): boolean {
    if (data.type !== "response") return false;
    const id = data.id;
    if (typeof id !== "string" || !this.pending.has(id)) return false;
    const pending = this.pending.get(id)!;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (data.success === false) {
      pending.reject(
        new Error(String((data as any).error ?? `RPC ${(data as any).command} failed`)),
      );
    } else {
      pending.resolve((data as any).data);
    }
    return true;
  }

  private handleAgentSettled() {
    this.settledCount++;
    for (const waiter of this.settleWaiters) {
      if (this.settledCount <= waiter.after) continue;
      this.settleWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private handleMessageUpdate(event: RpcEvent) {
    const assistantEvent = (event as any).assistantMessageEvent;
    if (!assistantEvent) return;
    const partial = assistantEvent.partial;
    if (!partial || partial.role !== "assistant") return;
    const text = getPartialText(partial as Message);
    if (!text || text === this.currentPartial) return;
    this.currentPartial = text;
    this.onPartial?.(text);
    this.onUpdate?.();
  }

  private handleMessageEnd(message: Message) {
    this.details.messages.push(message);
    if (message.role === "assistant") {
      this.details.usage.turns++;
      const u = (message as any).usage;
      if (u) {
        this.details.usage.input += u.input || 0;
        this.details.usage.output += u.output || 0;
        this.details.usage.cacheRead += u.cacheRead || 0;
        this.details.usage.cacheWrite += u.cacheWrite || 0;
        this.details.usage.cost += u.cost?.total || 0;
        this.details.usage.contextTokens = u.totalTokens || 0;
      }
      if ((message as any).stopReason) this.details.stopReason = (message as any).stopReason;
      if ((message as any).errorMessage) this.details.errorMessage = (message as any).errorMessage;
    }
    this.onUpdate?.();
  }

  // ── Internal: Error cleanup ──

  private rejectAll(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(error);
    }
    this.pending.clear();
  }

  private rejectSettlementWaiters(error: Error) {
    for (const waiter of this.settleWaiters) waiter.reject(error);
    this.settleWaiters.clear();
  }
}
