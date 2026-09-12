import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BtwChild, buildPiRpcInvocation, summarizeProviderError } from "../src/btw-child.ts";

test("summarizeProviderError strips HTML error pages down to readable text", () => {
  const htmlError =
    '404 <!DOCTYPE html><html><head><style>a{color:red}</style>' +
    "<script>var x=1;</script></head><body><h1>404 - Page Not Found</h1></body></html>";
  const summary = summarizeProviderError(htmlError);

  assert.ok(summary.startsWith("404"), summary);
  assert.doesNotMatch(summary, /</, "markup must be gone");
  assert.doesNotMatch(summary, /var x=1/, "scripts must be gone");
  assert.doesNotMatch(summary, /color:red/, "styles must be gone");
  assert.ok(summary.includes("Page Not Found"), summary);
});

test("summarizeProviderError caps length and leaves plain messages intact", () => {
  const plain = "Codex error: model not supported for this account.";
  assert.equal(summarizeProviderError(plain), plain);
  assert.equal(summarizeProviderError("x".repeat(500)).length, 300);
});

test("builds a runtime-safe Pi RPC invocation", () => {
  const invocation = buildPiRpcInvocation("openai-codex", "gpt-5.6-luna");
  const modeIndex = invocation.args.indexOf("--mode");
  const toolsIndex = invocation.args.indexOf("--tools");

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[modeIndex + 1], "rpc");
  assert.equal(invocation.args[toolsIndex + 1], "read,grep,find,ls");
  assert.ok(invocation.args.includes("--no-extensions"));
  assert.ok(invocation.args.includes("--no-session"));
  // A child lives for seconds; startup network calls are pure latency.
  assert.ok(invocation.args.includes("--offline"));

  if (!process.versions.bun) {
    assert.match(invocation.args[0] ?? "", /[\\/]dist[\\/]cli\.js$/);
  }
});

test("starts the RPC child, completes the handshake, and shuts down", async () => {
  const child = new BtwChild(process.cwd(), "openai-codex", "gpt-5.6-luna");
  try {
    await child.ready();
    assert.equal(child.details.errorMessage, undefined);
  } finally {
    await child.stop();
  }
});

test("surfaces startup errors and still cleans up", async () => {
  const missingCwd = join(tmpdir(), `pi-btw-missing-${process.pid}-${Date.now()}`);
  const child = new BtwChild(missingCwd, "openai-codex", "gpt-5.6-luna");

  await assert.rejects(child.ready(), /btw child process error/);
  assert.match(child.details.errorMessage ?? "", /ENOENT/);
  await child.stop();
});
