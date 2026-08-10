import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BtwChild, buildPiRpcInvocation } from "../src/btw-child.ts";

test("builds a runtime-safe Pi RPC invocation", () => {
  const invocation = buildPiRpcInvocation("openai-codex", "gpt-5.6-luna");
  const modeIndex = invocation.args.indexOf("--mode");
  const toolsIndex = invocation.args.indexOf("--tools");

  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.args[modeIndex + 1], "rpc");
  assert.equal(invocation.args[toolsIndex + 1], "read,grep,find,ls");
  assert.ok(invocation.args.includes("--no-extensions"));
  assert.ok(invocation.args.includes("--no-session"));

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
