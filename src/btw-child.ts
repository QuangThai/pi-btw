/**
 * BtwChild — RPC child process for /btw
 *
 * Spawns Pi's resolved CLI entry through the current runtime with
 * `--mode rpc --no-session` and communicates via JSONL over stdin/stdout.
 *
 * Based on the pi-smart-btw architecture:
 *   https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/main/packages/pi-smart-btw
 */

import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { BtwChildHandle, ChildDetails, RpcEvent } from "./types.ts";

// ── Defaults ──

const READY_TIMEOUT = 15_000;      // 15s for child to become ready
const RESPONSE_TIMEOUT = 120_000;  // 2min for a command response
const SETTLEMENT_TIMEOUT = 300_000; // 5min for a full answer to settle
const SHUTDOWN_GRACE = 2_000;      // 2s grace before SIGKILL
const AGENT_END_SETTLEMENT_GRACE = 250;
const CHILD_TOOLS = "read,grep,find,ls";

export interface BtwRpcInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve Pi through its package entry point instead of the platform-specific
 * `pi` npm shim. On Windows that shim is usually a .cmd file, which cannot be
 * launched by spawn() with shell:false. Bun binaries have no JS CLI file to
 * resolve, so they are launched directly.
 */
function resolvePiCliPath(): string | undefined {
  const packageDir = getPackageDir();
  const candidates = [
    join(packageDir, "dist", "cli.js"),
    join(packageDir, "cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function buildPiRpcInvocation(provider: string, modelId: string): BtwRpcInvocation {
  const cliPath = resolvePiCliPath();
  if (!cliPath && !process.versions.bun) {
    throw new Error(
      `Could not locate the Pi CLI under ${getPackageDir()}. ` +
      "Expected dist/cli.js; refusing to fall back to the PATH shim.",
    );
  }

  return {
    command: process.execPath,
    args: [
      ...(cliPath ? [cliPath] : []),
      "--mode", "rpc",
      "--no-session",
      // A child lives for seconds. Startup package/update network calls are
      // pure latency here, so opt out of them.
      "--offline",
      "--model", `${provider}/${modelId}`,
      // BTW is a read-only side session. Do not load extensions recursively;
      // custom/MCP tools must be explicitly bridged rather than inherited.
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--tools", CHILD_TOOLS,
    ],
  };
}

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

/**
 * Condense a provider error for display.
 *
 * Providers sometimes return a full HTML error page. Keep the leading status
 * line, drop the markup, and cap the length so the notice stays readable.
 */
export function summarizeProviderError(raw: string, max = 300): string {
  const stripped = raw
    .replace(/<!DOCTYPE[^>]*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const text = stripped || raw.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
      const textParts: string[] = [];
      const answerParts: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const p = part as any;
        // Standard text content
        if (p.type === "text" && typeof p.text === "string") {
          if (p.text.trim()) { textParts.push(p.text); answerParts.push(p.text); }
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
      // Prefer the real answer over reasoning: if the model emitted plain
      // text parts, join those and drop the thinking. Only fall back to the
      // reasoning stream when there is no plain text at all.
      if (answerParts.length > 0) return answerParts.join("\n\n").trim();
      if (textParts.length > 0) return textParts.join("\n\n").trim();
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
  private supportsSettledEvent = false;
  private agentEndSettlementTimer: ReturnType<typeof setTimeout> | undefined;
  private settleWaiters = new Set<{
    after: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private currentPartial = "";
  private onPartial: ((text: string) => void) | undefined;
  private closed = false;
  private processError: Error | undefined;
  private readonly spawnPromise: Promise<void>;
  private readonly onUpdate: (() => void) | undefined;

  constructor(cwd: string, provider: string, modelId: string, onUpdate?: () => void) {
    this.onUpdate = onUpdate;

    const invocation = buildPiRpcInvocation(provider, modelId);

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

    let resolveSpawn!: () => void;
    let rejectSpawn!: (error: Error) => void;
    this.spawnPromise = new Promise<void>((resolve, reject) => {
      resolveSpawn = resolve;
      rejectSpawn = reject;
    });
    // A child can be constructed and cleared before ready() is called.
    this.spawnPromise.catch(() => undefined);

    this.proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PI_BTW_CHILD: "1" },
    });

    this.proc.once("spawn", () => resolveSpawn());
    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      this.details.stderr += chunk.toString();
      this.onUpdate?.();
    });
    this.proc.stdin.on("error", (err: Error) => {
      const processError = this.makeProcessError(`btw child stdin error: ${err.message}`);
      this.fail(processError);
    });
    this.proc.once("close", (code: number | null) => {
      this.closed = true;
      if (this.agentEndSettlementTimer) {
        clearTimeout(this.agentEndSettlementTimer);
        this.agentEndSettlementTimer = undefined;
      }
      this.flushStdout();
      const error = this.processError ?? this.makeProcessError(
        code === null
          ? "btw child terminated before completing RPC"
          : `btw child exited with code ${code}`,
      );
      this.processError ??= error;
      rejectSpawn(this.processError);
      this.fail(this.processError);
    });
    this.proc.once("error", (err: Error) => {
      const processError = this.makeProcessError(`btw child process error: ${err.message}`);
      rejectSpawn(processError);
      this.fail(processError);
    });
  }

  // ── Public API ──

  async ready(): Promise<void> {
    await this.spawnPromise;
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
    // The child keeps one running total across its lifetime, so snapshot it
    // here to report usage for this answer alone.
    const beforeUsage = { ...this.details.usage };
    this.currentPartial = "";
    this.onPartial = onPartial;
    // Scope stop/error reporting to this ask so a provider failure here is not
    // confused with one from an earlier question in the same slot.
    this.details.stopReason = undefined;
    this.details.errorMessage = undefined;

    try {
      const messageText = [
        "Answer the user's question directly.",
        "Be concise unless the question requires detail.",
        ...(contextMessage ? [contextMessage] : []),
        `Question: ${question}`,
      ].join("\n\n");

      await this.send({
        type: "prompt",
        message: messageText,
        streamingBehavior: "followUp",
      });

      await this.waitForSettlement(before);
      const answer = (
        getFinalOutput(this.details.messages.slice(beforeMessages)) ||
        this.currentPartial
      ).trim();
      // A provider failure inside the child settles the turn with an error
      // message and no text. Surface it instead of reporting an empty answer.
      if (!answer && (this.details.stopReason === "error" || this.details.errorMessage)) {
        throw new Error(
          this.details.errorMessage
            ? `btw child could not answer: ${summarizeProviderError(this.details.errorMessage)}`
            : "btw child could not answer (provider returned an error)",
        );
      }
      return answer;
    } finally {
      this.onPartial = undefined;
      this.details.lastAskUsage = {
        input: this.details.usage.input - beforeUsage.input,
        output: this.details.usage.output - beforeUsage.output,
        cacheRead: this.details.usage.cacheRead - beforeUsage.cacheRead,
        cacheWrite: this.details.usage.cacheWrite - beforeUsage.cacheWrite,
        cost: this.details.usage.cost - beforeUsage.cost,
      };
    }
  }

  /**
   * Stop the in-flight turn but keep the process alive so the slot can be
   * reused. Never rejects: aborting a child that already died is a no-op.
   */
  async abort(): Promise<void> {
    if (this.closed || this.processError) return;
    try {
      await this.send({ type: "abort" }, RESPONSE_TIMEOUT);
    } catch {
      // The child is gone or unresponsive; stop() is the caller's fallback.
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        this.proc.off("close", onClose);
        resolve();
      };
      const onClose = () => finish();
      // SIGTERM is advisory. Escalate to SIGKILL, then wait for the real close
      // so callers know the process is actually gone before they continue.
      const killTimer = setTimeout(() => {
        if (this.closed) return finish();
        this.proc.kill("SIGKILL");
        // Give the OS a moment to reap it, then stop waiting regardless.
        setTimeout(finish, SHUTDOWN_GRACE).unref?.();
      }, SHUTDOWN_GRACE);
      killTimer.unref?.();
      this.proc.once("close", onClose);
      if (this.closed) finish();
    });
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
      // A child that stops emitting events must not hang the slot forever.
      const timeout = setTimeout(() => {
        this.settleWaiters.delete(waiter);
        reject(
          new Error(
            `btw child did not finish within ${Math.round(SETTLEMENT_TIMEOUT / 1000)}s`,
          ),
        );
      }, SETTLEMENT_TIMEOUT);
      timeout.unref?.();
      const waiter = {
        after,
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error: Error) => { clearTimeout(timeout); reject(error); },
      };
      this.settleWaiters.add(waiter);
    });
  }

  // ── Internal: JSONL send ──

  private send<T = unknown>(
    command: Record<string, unknown>,
    timeoutMs = RESPONSE_TIMEOUT,
  ): Promise<T> {
    if (this.closed || this.processError || !this.proc.stdin.writable)
      throw this.processError ?? this.makeProcessError("btw child RPC is not available");
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
          const writeError = this.makeProcessError(
            `btw child stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          this.fail(writeError);
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
    if (data.type === "agent_settled") this.handleAgentSettled(true);
    if (data.type === "agent_end") this.handleAgentEnd(data);
    if (data.type === "message_end" && data.message)
      this.handleMessageEnd(data.message as Message);
    if (data.type === "message_update") this.handleMessageUpdate(data);
  }

  private handleResponse(data: RpcEvent): boolean {
    if (data.type !== "response") return false;
    const id = data.id;
    if (typeof id !== "string" || !this.pending.has(id)) {
      // Protocol-level failures (for example a parse error) come back without
      // a request id. Fail fast instead of letting every request time out.
      if (data.success === false) {
        const error = new Error(
          String((data as any).error ?? `RPC ${(data as any).command ?? "command"} failed`),
        );
        this.rejectAll(error);
        this.rejectSettlementWaiters(error);
        return true;
      }
      return false;
    }
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

  private handleAgentEnd(event: RpcEvent): void {
    // Pi >= 0.84 emits agent_settled after retries/queued work. Older Pi
    // versions only emit agent_end, which is terminal for their RPC mode.
    if (this.supportsSettledEvent || event.willRetry === true) return;
    if (this.agentEndSettlementTimer) clearTimeout(this.agentEndSettlementTimer);
    this.agentEndSettlementTimer = setTimeout(() => {
      this.agentEndSettlementTimer = undefined;
      if (!this.supportsSettledEvent) this.handleAgentSettled(false);
    }, AGENT_END_SETTLEMENT_GRACE);
  }

  private handleAgentSettled(fromProtocol: boolean): void {
    if (fromProtocol) {
      this.supportsSettledEvent = true;
      if (this.agentEndSettlementTimer) {
        clearTimeout(this.agentEndSettlementTimer);
        this.agentEndSettlementTimer = undefined;
      }
    }
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

  private makeProcessError(message: string): Error {
    const stderr = this.details.stderr.trim();
    return new Error(`${message}${stderr ? ` Stderr: ${stderr}` : ""}`);
  }

  private fail(error: Error): void {
    this.processError ??= error;
    this.details.errorMessage = this.processError.message;
    this.rejectAll(this.processError);
    this.rejectSettlementWaiters(this.processError);
    this.onUpdate?.();
  }

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
