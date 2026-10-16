import "./support/agent-dir.mts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionManager,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  collectSmartContext,
  type BtwContextStrategy,
  type BtwSettings,
} from "../extensions/btw.ts";

const strategies: BtwContextStrategy[] = ["full", "smart", "budget", "last-n", "compact"];

function settings(strategy: BtwContextStrategy): BtwSettings {
  return { strategy, maxTokens: 1000, maxContextTokens: 8000, recentExchanges: 8 };
}

function context(session: SessionManager): ExtensionContext {
  return { sessionManager: session } as unknown as ExtensionContext;
}

function user(session: SessionManager, content: string): string {
  return session.appendMessage({ role: "user", content, timestamp: Date.now() });
}

function text(ctx: ExtensionContext, strategy: BtwContextStrategy): string {
  return JSON.stringify(collectSmartContext(ctx, settings(strategy)));
}

test("all context strategies respect the latest compaction boundary", () => {
  const session = SessionManager.inMemory(process.cwd());
  user(session, "discarded-before-first-compaction");
  const firstKept = user(session, "discarded-before-second-compaction");
  session.appendCompaction("superseded-summary", firstKept, 10000);
  const retained = user(session, "retained-before-compaction");
  session.appendCompaction("current-summary", retained, 12000);
  user(session, "latest-question");

  for (const strategy of strategies) {
    const result = text(context(session), strategy);
    assert.doesNotMatch(result, /discarded-before|superseded-summary/, strategy);
    assert.match(result, /current-summary/, strategy);
    assert.match(result, /retained-before-compaction/, strategy);
    assert.match(result, /latest-question/, strategy);
  }
  assert.match(JSON.stringify(session.getBranch()), /discarded-before/,
    "collecting context must not rewrite the raw history");
});

// Older Pi releases support compaction but do not expose context edits yet.
const supportsContextEdits = "appendContextEdit" in SessionManager.prototype;
function edit(session: SessionManager, targetId: string, replacement: string | null): void {
  const editable = session as SessionManager & {
    appendContextEdit(targetId: string, replacement: { content: string } | null): string;
  };
  editable.appendContextEdit(targetId, replacement === null ? null : { content: replacement });
}

test("all strategies honor omissions and the latest content replacement", {
  skip: !supportsContextEdits,
}, () => {
  const session = SessionManager.inMemory(process.cwd());
  user(session, "older-context");
  const omitted = user(session, "omitted-attempt");
  const replaced = user(session, "original-content");
  session.appendCompaction("current-summary", omitted, 10000);
  edit(session, omitted, null);
  edit(session, replaced, "superseded-replacement");
  edit(session, replaced, "current-content");

  for (const strategy of strategies) {
    const result = text(context(session), strategy);
    assert.doesNotMatch(result, /omitted-attempt|original-content|superseded-replacement/, strategy);
    assert.match(result, /current-content/, strategy);
  }
  assert.match(JSON.stringify(session.getBranch()), /omitted-attempt|original-content/);
});

test("context edits are relative to the active branch", { skip: !supportsContextEdits }, () => {
  const session = SessionManager.inMemory(process.cwd());
  const target = user(session, "original-branch-content");
  edit(session, target, "edited-branch-content");
  assert.match(text(context(session), "full"), /edited-branch-content/);
  session.branch(target);
  assert.match(text(context(session), "full"), /original-branch-content/);
  assert.doesNotMatch(text(context(session), "full"), /edited-branch-content/);
});

test("full context includes branch summaries and custom messages but not BTW entries", () => {
  const session = SessionManager.inMemory(process.cwd());
  const root = user(session, "main-question");
  user(session, "abandoned-branch-message");
  session.branchWithSummary(root, "branch-summary-evidence");
  session.appendCustomMessageEntry("project-note", "custom-context-evidence", false);
  session.appendCustomMessageEntry("btw-entry", "isolated-side-answer", false);
  user(session, "[BTW Answer Injection] explicitly-shared-answer");

  const result = text(context(session), "full");
  assert.match(result, /branch-summary-evidence/);
  assert.match(result, /custom-context-evidence/);
  assert.match(result, /explicitly-shared-answer/);
  assert.doesNotMatch(result, /abandoned-branch-message|isolated-side-answer/);
});

test("system prompt checkpoints are not copied into a side question", () => {
  const entries = [{
    type: "message", id: "system", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "system", content: "main-system-prompt", timestamp: Date.now() },
  }, {
    type: "message", id: "user", parentId: "system", timestamp: new Date().toISOString(),
    message: { role: "user", content: "main-question", timestamp: Date.now() },
  }] as unknown as SessionEntry[];
  const ctx = { sessionManager: { getBranch: () => entries } } as ExtensionContext;
  const result = text(ctx, "full");
  assert.doesNotMatch(result, /main-system-prompt/);
  assert.match(result, /main-question/);
});

test("none requests no history even when the token limit is disabled", () => {
  const ctx = {
    sessionManager: { getBranch: () => { throw new Error("history must not be read"); } },
  } as unknown as ExtensionContext;
  assert.deepEqual(collectSmartContext(ctx, { ...settings("none"), maxContextTokens: 0 }), []);
});

test("smart and budget still enforce the token budget after resolving context", () => {
  const session = SessionManager.inMemory(process.cwd());
  user(session, "over-budget-history-" + "x".repeat(8000));
  user(session, "short-latest-question");
  for (const strategy of ["smart", "budget"] as const) {
    const result = collectSmartContext(context(session), { ...settings(strategy), maxContextTokens: 1000 });
    assert.equal(result.length, 1, strategy);
    assert.match(JSON.stringify(result), /short-latest-question/, strategy);
  }
});

test("last-n and compact retain their existing recent-message limits", () => {
  const session = SessionManager.inMemory(process.cwd());
  const firstKept = user(session, "recent-1");
  session.appendCompaction("current-summary", firstKept, 10000);
  for (let n = 2; n <= 6; n++) user(session, `recent-${n}`);
  const ctx = context(session);
  const lastN = collectSmartContext(ctx, { ...settings("last-n"), recentExchanges: 1 });
  assert.equal(lastN.length, 2);
  assert.match(JSON.stringify(lastN), /recent-5/);
  assert.doesNotMatch(JSON.stringify(lastN), /recent-4/);
  const compact = collectSmartContext(ctx, settings("compact"));
  assert.equal(compact.length, 5, "summary plus four recent messages");
  assert.match(JSON.stringify(compact), /current-summary/);
  assert.doesNotMatch(JSON.stringify(compact), /recent-2/);
});
