/**
 * /btw — Side Questions for Pi Coding Agent
 *
 * Droid-style: side questions appear in a bordered scrollable component
 * that replaces the editor. Full keyboard support.
 *
 * Usage:
 *   /btw <question>    → full answer view (scrollable, Esc to dismiss)
 *   /btw               → history browser (↑↓ nav, Enter expand, d delete)
 *   Alt+B              → latest answer (same as /btw <question>)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToLlm, getAgentDir, getMarkdownTheme, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { Component, MarkdownTheme } from "@earendil-works/pi-tui";
import { Key, Markdown, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface BtwUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalCost: number;
}
export interface BtwEntry {
  id: string; question: string; answer: string; modelProvider: string; modelId: string;
  timestamp: number; usage?: BtwUsage; error?: string;
}
export interface BtwSettings { maxTokens: number; }
const DEFAULT_SETTINGS: BtwSettings = { maxTokens: 1000 };

// ────────────────────────────────────────────────────────────────
// Module-level state
// ────────────────────────────────────────────────────────────────

let btwEntries: BtwEntry[] = [];
let btwSettings: BtwSettings = { ...DEFAULT_SETTINGS };
let entryCounter = 0;
let api: ExtensionAPI | null = null;

// ────────────────────────────────────────────────────────────────
// Settings persistence
// ────────────────────────────────────────────────────────────────

function getGlobalSettingsPath(): string { return join(getAgentDir(), "btw-settings.json"); }
function loadGlobalSettings(): BtwSettings {
  try { const d = JSON.parse(readFileSync(getGlobalSettingsPath(), "utf8")); return { maxTokens: typeof d.maxTokens === "number" ? d.maxTokens : DEFAULT_SETTINGS.maxTokens }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveGlobalSettings(s: BtwSettings): void {
  const f = getGlobalSettingsPath(); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`, "utf8");
}

// ────────────────────────────────────────────────────────────────
// Entry management
// ────────────────────────────────────────────────────────────────

function genId(): string { return `btw-${++entryCounter}-${Date.now()}`; }

function addEntry(e: BtwEntry): void {
  btwEntries.push(e);
  api?.appendEntry("btw-entry", {
    id: e.id, question: e.question, answer: e.answer,
    modelProvider: e.modelProvider, modelId: e.modelId, timestamp: e.timestamp,
    usage: e.usage, error: e.error,
  });
}

function delEntry(id: string): void { btwEntries = btwEntries.filter(e => e.id !== id); }

function restore(ctx: ExtensionContext): void {
  btwEntries = [];
  for (const e of ctx.sessionManager.getEntries()) {
    if (e.type === "custom" && e.customType === "btw-entry") {
      const d = e.data as Record<string, unknown>;
      if (d && typeof d.id === "string" && typeof d.question === "string")
        btwEntries.push({
          id: d.id as string, question: d.question as string, answer: (d.answer as string) ?? "",
          modelProvider: (d.modelProvider as string) ?? "", modelId: (d.modelId as string) ?? "",
          timestamp: (d.timestamp as number) ?? 0, usage: d.usage as BtwUsage | undefined,
          error: d.error as string | undefined,
        });
    }
  }
  for (const e of btwEntries) { const m = e.id.match(/^btw-(\d+)-/); if (m) { const n = parseInt(m[1]!, 10); if (n >= entryCounter) entryCounter = n + 1; } }
}

// ────────────────────────────────────────────────────────────────
// Format helpers
// ────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────
// System prompt
// ────────────────────────────────────────────────────────────────

const PROMPT = [
  "You are a quick side-question assistant inside a coding agent session.",
  "",
  "IMPORTANT:",
  "- You are a SEPARATE, LIGHTWEIGHT agent spawned to answer this ONE question.",
  "- The main coding agent is NOT interrupted.",
  "- You share the conversation context but are a completely separate instance.",
  "",
  "CRITICAL:",
  "- You have NO tools. Do not call, request, simulate, or output tool calls.",
  "- This is a ONE-OFF response — there will be no follow-up turns.",
  '- NEVER say "Let me try..." or simulate action.',
  "- Answer directly using the provided context.",
  "- Format code blocks with language tags.",
].join("\n");

// ────────────────────────────────────────────────────────────────
// Engine
// ────────────────────────────────────────────────────────────────

function collectMsgs(ctx: ExtensionContext): AgentMessage[] {
  const r: AgentMessage[] = [];
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type === "message") r.push(e.message);
    else if (e.type === "compaction") r.push({
      role: "compactionSummary" as AgentMessage["role"],
      summary: e.summary, tokensBefore: e.tokensBefore, timestamp: new Date(e.timestamp).getTime(),
    } as unknown as AgentMessage);
  }
  return r;
}

async function ask(ctx: ExtensionContext, question: string, signal: AbortSignal):
  Promise<{ answer: string; usage?: BtwUsage; error?: string }> {
  if (!ctx.model) return { error: "No model selected. Run /model first." };
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
  if (!auth.ok || !auth.apiKey)
    return { error: auth.ok ? `No API key for ${ctx.model.provider}.` : auth.error };

  let conv: string;
  try { conv = serializeConversation(convertToLlm(collectMsgs(ctx))); }
  catch { conv = "(no context)"; }

  try {
    const msg: UserMessage = { role: "user", timestamp: Date.now(), content: [{ type: "text", text: `## Current Context\n\n${conv}\n\n## Question\n\n${question}` }] };
    const res = await complete(ctx.model, { systemPrompt: PROMPT, messages: [msg] }, { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal, maxTokens: btwSettings.maxTokens });
    if (res.stopReason === "aborted") return { error: "Cancelled" };
    const answer = (res.content as Array<{ type: string; text: string }>).filter(c => c.type === "text").map(c => c.text).join("\n");
    return { answer, usage: { input: (res.usage as any)?.input ?? 0, output: (res.usage as any)?.output ?? 0, cacheRead: (res.usage as any)?.cacheRead ?? 0, cacheWrite: (res.usage as any)?.cacheWrite ?? 0, totalCost: (res.usage as any)?.cost?.total ?? 0 } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const low = msg.toLowerCase();
    if (/no api key|unauthorized|auth|401|403/.test(low)) return { error: `Auth failed for ${ctx.model.provider}.` };
    if (/rate.?limit|429|quota|billing/.test(low)) return { error: `Rate-limited on ${ctx.model.id}.` };
    if (/timeout|network|fetch|connection|502|503/.test(low)) return { error: `Provider unreachable for ${ctx.model.id}.` };
    return { error: msg };
  }
}

// ────────────────────────────────────────────────────────────────
// UI helpers (shared)
// ────────────────────────────────────────────────────────────────

/** Content row: ║ <content padded to cw> ║ */
function L(T: Theme, content: string, cw: number): string {
  return `${T.fg("border", "║")} ${truncateToWidth(content || "", cw, "", true)} ${T.fg("border", "║")}`;
}
/** Separator: ║ ──────── ║ */
function S(T: Theme, cw: number): string {
  return `${T.fg("border", "║")} ${T.fg("border", "─".repeat(cw))} ${T.fg("border", "║")}`;
}

// ════════════════════════════════════════════════════════════════
// Component: Full answer view (replaces editor via custom())
// ════════════════════════════════════════════════════════════════

class BtwAnswerView implements Component {
  private scrollOff = 0;
  private md: Markdown;
  private mdTheme: MarkdownTheme;
  private maxVis = 30; // visible lines before scroll kicks in

  constructor(
    private tui: { requestRender(): void },
    private theme: Theme,
    private entry: BtwEntry,
    private onClose: () => void,
  ) {
    this.mdTheme = getMarkdownTheme();
    this.md = new Markdown(this.entry.answer || "", 1, 0, this.mdTheme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.onClose(); return; }
    if (matchesKey(data, Key.up)) { this.scrollOff = Math.max(0, this.scrollOff - 1); this.tui.requestRender(); return; }
    if (matchesKey(data, Key.down)) { this.scrollOff++; this.tui.requestRender(); return; }
  }
  invalidate(): void { this.md = new Markdown(this.entry.answer || "", 1, 0, this.mdTheme); }

  render(width: number): string[] {
    const T = this.theme;
    const cw = Math.max(28, width - 4);
    const lines: string[] = [];
    const e = this.entry;

    // ╔═ /btw ═══════════════════════════════════════╗
    const lbl = " /btw ";
    const topD = Math.max(0, width - 3 - 6);
    lines.push(T.fg("border", `╔═${lbl}${"═".repeat(topD)}╗`));

    // Question
    lines.push(L(T, ` ${T.fg("accent", "\u2753")} ${T.fg("text", e.question)}`, cw));

    if (e.error) {
      lines.push(S(T, cw));
      lines.push(L(T, ` ${T.fg("error", "\u2717")} ${e.error}`, cw));
    } else if (e.answer) {
      lines.push(S(T, cw));

      // Full markdown answer, scrollable
      const mdL = this.md.render(cw - 2);
      this.scrollOff = Math.min(this.scrollOff, Math.max(0, mdL.length - this.maxVis));
      const vis = mdL.slice(this.scrollOff, this.scrollOff + this.maxVis);
      for (const mdLine of vis) lines.push(L(T, ` ${mdLine}`, cw));

      if (mdL.length > this.maxVis) {
        const st = `\u2191\u2193 scroll \u00b7 ${this.scrollOff + 1}\u2013${this.scrollOff + vis.length} of ${mdL.length}`;
        lines.push(L(T, ` ${T.fg("dim", st)}`, cw));
      } else if (vis.length < 3) {
        for (let r = vis.length; r < 3; r++) lines.push(L(T, "", cw));
      }
    } else {
      lines.push(S(T, cw));
      lines.push(L(T, ` ${T.fg("dim", "No answer.")}`, cw));
    }

    // Metadata
    lines.push(S(T, cw));
    const meta: string[] = [];
    if (e.modelId) meta.push(T.fg("dim", e.modelId));
    if (e.usage?.output) meta.push(T.fg("dim", `${fmtTokens(e.usage.output)} out`));
    if (e.usage?.input) meta.push(T.fg("dim", `${fmtTokens(e.usage.input)} in`));
    if (e.usage?.totalCost) meta.push(T.fg("dim", `\$${e.usage.totalCost.toFixed(4)}`));
    lines.push(L(T, meta.length ? meta.join(" \u00b7 ") : "", cw));

    // ══ bottom border (no nested T.fg, parts split) ══
    const hp = " \u2191\u2193 scroll  Esc dismiss  /btw history ";
    const hv = [...hp].length;
    const hintsDim = ` ${T.fg("dim", "\u2191\u2193 scroll")}  ${T.fg("dim", "Esc dismiss")}  ${T.fg("dim", "/btw history")} `;
    const dd = Math.max(0, width - 2 - hv);
    lines.push(
      T.fg("border", `╚${"═".repeat(dd)}`) +
      hintsDim +
      T.fg("border", "╝")
    );

    lines.push("");
    return lines;
  }

  dispose(): void {}
}

// ════════════════════════════════════════════════════════════════
// Component: History browser (replaces editor via custom())
// ════════════════════════════════════════════════════════════════

class BtwHistoryView implements Component {
  selectedIndex = 0;
  expandedIndex: number | null = null;
  private scrollOff = 0;
  private md: Markdown;
  private mdTheme: MarkdownTheme;

  constructor(
    private tui: { requestRender(): void },
    private theme: Theme,
    private onClose: () => void,
    private onDelete: (id: string) => void,
    initialIndex: number,
    initialExpanded: number | null,
  ) {
    this.mdTheme = getMarkdownTheme();
    this.md = new Markdown("", 1, 0, this.mdTheme);
    this.selectedIndex = initialIndex;
    this.expandedIndex = initialExpanded;
    if (initialExpanded !== null && btwEntries[initialExpanded]?.answer)
      this.md.setText(btwEntries[initialExpanded]!.answer);
  }

  handleInput(data: string): void {
    const n = btwEntries.length;
    if (matchesKey(data, Key.escape)) { this.onClose(); return; }
    if (data === "q") { this.onClose(); return; }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      if (this.expandedIndex !== null) {
        if (this.scrollOff <= 0) {
          this.expandedIndex = null; this.scrollOff = 0;
          this.selectedIndex = this.selectedIndex <= 0 ? n - 1 : this.selectedIndex - 1;
        } else { this.scrollOff--; }
      } else {
        this.selectedIndex = this.selectedIndex <= 0 ? n - 1 : this.selectedIndex - 1;
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (this.expandedIndex !== null) {
        const mdL = this.md.render(this.maxMdW());
        if (this.scrollOff >= Math.max(0, mdL.length - 30)) {
          this.expandedIndex = null; this.scrollOff = 0;
          this.selectedIndex = this.selectedIndex >= n - 1 ? 0 : this.selectedIndex + 1;
        } else { this.scrollOff++; }
      } else {
        this.selectedIndex = this.selectedIndex >= n - 1 ? 0 : this.selectedIndex + 1;
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (matchesKey(data, Key.enter)) {
      if (this.expandedIndex === this.selectedIndex) {
        this.expandedIndex = null; this.scrollOff = 0;
      } else {
        this.expandedIndex = this.selectedIndex; this.scrollOff = 0;
        this.md.setText(btwEntries[this.selectedIndex]?.answer ?? "");
      }
      this.invalidate(); this.tui.requestRender(); return;
    }

    if (data === "d" || data === "D") {
      const e = btwEntries[this.selectedIndex]; if (!e) return;
      this.onDelete(e.id);
      if (this.expandedIndex === this.selectedIndex) { this.expandedIndex = null; this.scrollOff = 0; }
      if (this.selectedIndex >= btwEntries.length) this.selectedIndex = Math.max(0, btwEntries.length - 1);
      this.invalidate(); this.tui.requestRender();
    }
  }

  invalidate(): void {
    if (this.expandedIndex !== null && btwEntries[this.expandedIndex])
      this.md.setText(btwEntries[this.expandedIndex]!.answer);
  }

  private maxMdW(): number { return Math.max(36, 80) - 6; }

  render(width: number): string[] {
    const T = this.theme;
    const cw = Math.max(36, width - 4);
    const lines: string[] = [];
    const items = btwEntries;

    // ╔═ /btw  Side Questions (N) ══════════════╗
    const hdr = ` /btw  Side Questions${items.length > 0 ? ` (${items.length})` : ""} `;
    const hdrL = [...hdr].length;
    lines.push(T.fg("border", `╔═${hdr}${"═".repeat(Math.max(0, width - 3 - hdrL))}╗`));

    if (items.length === 0) {
      lines.push(L(T, ` ${T.fg("dim", "No side questions yet.")}`, cw));
      lines.push(L(T, ` ${T.fg("dim", "Type")} ${T.fg("accent", "/btw <question>")} ${T.fg("dim", "to ask one.")}`, cw));
      lines.push(L(T, "", cw));
    } else {
      for (let i = 0; i < items.length; i++) {
        const e = items[i]!;
        const sel = i === this.selectedIndex;
        const exp = i === this.expandedIndex;
        if (i > 0) lines.push(S(T, cw));

        // Question
        const mrk = sel ? T.fg("accent", "\u25b8") : " ";
        lines.push(L(T, `${mrk} ${T.fg("dim", `${i + 1}`)}  ${T.fg(sel ? "accent" : "text", e.question)}`, cw));

        if (exp && !e.error && e.answer) {
          const mdL = this.md.render(cw - 2);
          const max = 30;
          this.scrollOff = Math.min(this.scrollOff, Math.max(0, mdL.length - max));
          const vis = mdL.slice(this.scrollOff, this.scrollOff + max);
          for (const l of vis) lines.push(L(T, ` ${l}`, cw));
          if (mdL.length > max) {
            const st = `\u2191\u2193 scroll \u00b7 ${this.scrollOff + 1}\u2013${this.scrollOff + vis.length} of ${mdL.length}`;
            lines.push(L(T, ` ${T.fg("dim", st)}`, cw));
          }
          // Metadata
          const meta: string[] = [];
          if (e.modelId) meta.push(T.fg("dim", e.modelId));
          meta.push(T.fg("dim", fmtTime(e.timestamp)));
          if (e.usage?.input) meta.push(T.fg("dim", `in ${fmtTokens(e.usage.input)}`));
          if (e.usage?.output) meta.push(T.fg("dim", `out ${fmtTokens(e.usage.output)}`));
          if (e.usage?.totalCost) meta.push(T.fg("dim", `\$${e.usage.totalCost.toFixed(4)}`));
          if (meta.length) lines.push(L(T, ` ${meta.join(" \u00b7 ")}`, cw));
        } else if (exp && e.error) {
          lines.push(L(T, ` ${T.fg("error", "\u2717")} ${e.error}`, cw));
        }
      }
    }

    // ══ bottom border ══
    const isExp = this.expandedIndex !== null;
    const hp = ` \u2191\u2193 nav \u00b7 Enter${isExp ? " collapse" : " expand"} \u00b7 d del \u00b7 Esc/q close `;
    const hv = [...hp].length;
    const hintsDim = ` ${T.fg("dim", `\u2191\u2193 nav \u00b7 Enter${isExp ? " collapse" : " expand"} \u00b7 d del \u00b7 Esc/q close`)} `;
    const dd = Math.max(0, width - 2 - hv);
    lines.push(
      T.fg("border", `╚${"═".repeat(dd)}`) +
      hintsDim +
      T.fg("border", "╝")
    );

    lines.push("");
    return lines;
  }

  dispose(): void {}
}

// ────────────────────────────────────────────────────────────────
// Extension entry point
// ────────────────────────────────────────────────────────────────

export default function (ext: ExtensionAPI) {
  api = ext;
  btwSettings = loadGlobalSettings();
  ext.on("session_start", async (_e, ctx) => { restore(ctx); });

  // ── /btw command ──────────────────────────────────────────────
  ext.registerCommand("btw", {
    description: "Ask a side question (/btw <q>), or open history (/btw)",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (q) { await doAsk(ctx, q); }
      else { await showHistory(ctx); }
    },
  });


}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function showAnswer(ctx: ExtensionContext, entry: BtwEntry): Promise<void> {
  await ctx.ui.custom<void>((tui, th, _kb, done) => {
    return new BtwAnswerView(tui, th as unknown as Theme, entry, () => done(undefined));
  });
}

async function showHistory(ctx: ExtensionContext): Promise<void> {
  if (btwEntries.length === 0) {
    ctx.ui.notify("No side questions yet. Try /btw <question>", "info");
    return;
  }
  await ctx.ui.custom<void>((tui, th, _kb, done) => {
    return new BtwHistoryView(
      tui, th as unknown as Theme,
      () => done(undefined),
      (id) => { delEntry(id); },
      0, null,
    );
  });
}

async function doAsk(ctx: ExtensionContext, question: string): Promise<void> {
  if (!ctx.model) { ctx.ui.notify("No model selected.", "error"); return; }
  ctx.ui.setStatus("btw", "\u03c0 /btw asking...");
  const ac = new AbortController();
  const r = await ask(ctx, question, ac.signal);
  ctx.ui.setStatus("btw", undefined);

  addEntry({
    id: genId(), question, answer: r.answer ?? "",
    modelProvider: ctx.model.provider, modelId: ctx.model.id,
    timestamp: Date.now(), usage: r.usage, error: r.error,
  });

  // Show the answer immediately in full
  const latest = btwEntries[btwEntries.length - 1]!;
  await showAnswer(ctx, latest);
}
