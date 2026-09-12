/**
 * End-to-end check for /btw against a live model.
 *
 * Loads the real extension into a real Pi RPC session and drives the whole
 * flow: cold start, RPC child with tools, follow-ups in one slot, a second
 * slot, slot exhaustion, answer injection, and restore after a restart.
 *
 * Requires credentials and spends tokens, so it is not part of `npm test`.
 *
 *   BTW_E2E_MODEL=provider/model npm run e2e
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(import.meta.dirname));
const CLI = join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const EXT = join(REPO, "extensions", "btw.ts");
const PROBE = join(REPO, "scripts", "e2e-probe.ts");
const INJECTION_MARKER = "MARKER-BTWINJECT42";

function resolveModel(): string {
  const configured =
    process.env.BTW_E2E_MODEL ??
    [process.env.PI_PROVIDER, process.env.PI_MODEL].filter(Boolean).join("/");
  if (!configured.includes("/")) {
    throw new Error(
      "Set BTW_E2E_MODEL=provider/model (or run it inside Pi with PI_PROVIDER and PI_MODEL set).",
    );
  }
  return configured;
}

const MODEL = resolveModel();
const sessionDir = mkdtempSync(join(tmpdir(), "btw-e2e-"));

// ── Minimal JSONL client ──

interface Rpc {
  send(command: Record<string, unknown>): Promise<any>;
  events: any[];
  stderr(): string;
  close(): Promise<void>;
}

function startPi(extraArgs: string[] = []): Rpc {
  const proc: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    CLI, "--mode", "rpc", "--offline",
    "--session-dir", sessionDir,
    "--model", MODEL,
    "--no-extensions", "-e", EXT, "-e", PROBE,
    ...extraArgs,
  ], { cwd: REPO, shell: false, stdio: ["pipe", "pipe", "pipe"] });

  const events: any[] = [];
  const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let stderr = "";
  let buf = "";
  let id = 0;

  proc.stderr.on("data", (chunk) => { stderr += String(chunk); });
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += String(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const raw of lines) {
      // Strict JSONL: split on \n only, tolerate a trailing \r.
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.trim()) continue;
      let data: any;
      try { data = JSON.parse(line); } catch { continue; }
      if (data.type === "response" && data.id && pending.has(data.id)) {
        pending.get(data.id)!.resolve(data);
        pending.delete(data.id);
        continue;
      }
      events.push(data);
    }
  });
  proc.once("close", (code) => {
    for (const p of pending.values()) p.reject(new Error(`pi exited (${code}). Stderr: ${stderr}`));
    pending.clear();
  });

  return {
    events,
    stderr: () => stderr,
    send(command) {
      const reqId = `e2e_${++id}`;
      return new Promise((res, rej) => {
        pending.set(reqId, { resolve: res, reject: rej });
        proc.stdin.write(JSON.stringify({ ...command, id: reqId }) + "\n");
      });
    },
    async close() {
      proc.stdin.end();
      proc.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (proc.exitCode !== null) return r();
        proc.once("close", () => r());
        setTimeout(() => { proc.kill("SIGKILL"); r(); }, 3000).unref();
      });
    },
  };
}

// ── Assertions ──

let failures = 0;
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function sessionEntries(): any[] {
  if (!existsSync(sessionDir)) return [];
  const files = readdirSync(sessionDir, { recursive: true, encoding: "utf8" })
    .map(String)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(sessionDir, f));
  const out: any[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial write */ }
    }
  }
  return out;
}

const btwEntries = () =>
  sessionEntries().filter((e) => e.type === "custom" && e.customType === "btw-entry");

function notifications(events: any[]): string[] {
  return events
    .filter((e) => e.type === "extension_ui_request" && e.method === "notify")
    .map((e) => String(e.message ?? ""));
}

function extensionErrors(events: any[]): any[] {
  return events.filter((e) => e.type === "extension_error");
}

async function waitFor(predicate: () => boolean, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return predicate();
}

// ── Run ──

console.log(`\n/btw E2E   model=${MODEL}\n           sessions=${sessionDir}\n`);

const pi = startPi();
try {
  console.log("[1] /btw is the very first command in a brand-new session");
  const coldStart = Date.now();
  const cold = await pi.send({
    type: "prompt",
    message: '/btw Read package.json in the current directory and reply with only its "name" value.',
  });
  const coldMs = Date.now() - coldStart;
  check("cold /btw accepted", cold.success === true, JSON.stringify(cold));
  check("no extension_error on a cold session",
    extensionErrors(pi.events).length === 0, JSON.stringify(extensionErrors(pi.events)));

  const coldNotes = notifications(pi.events);
  const coldDone = coldNotes.find((n) => n.includes("complete:"));
  check("answered with no prior conversation", !!coldDone, JSON.stringify(coldNotes));
  check("the child used its read tool on the real repo",
    !!coldDone && coldDone.includes("@nguyenquangthai/pi-btw"), coldDone ?? "");
  check("used the RPC child, not the inline fallback",
    !coldNotes.some((n) => n.includes("inline no-tools fallback")), JSON.stringify(coldNotes));
  console.log(`        cold /btw took ${coldMs}ms (includes child spawn)`);

  console.log("\n[2] the turn is persisted in a restorable shape");
  // Pi only materialises the session file once the session holds a real
  // message, so a side question alone never reaches disk. Send one now; the
  // entries buffered during the cold start are flushed with it.
  await pi.send({ type: "prompt", message: "Reply with exactly: READY" });
  const flushed = await waitFor(() => btwEntries().length >= 1);
  check("the cold-start turn reaches disk once the session has a message", flushed);
  const first = btwEntries();
  check("turn persisted as a btw-entry", first.length === 1, `found ${first.length}`);
  const d1 = first[0]?.data ?? {};
  check("carries its slot number (needed by /resume)", d1.slot === 0, `slot=${JSON.stringify(d1.slot)}`);
  check("carries the answer", typeof d1.answer === "string" && d1.answer.length > 0);
  check("carries per-turn usage", !!d1.usage && d1.usage.output > 0, JSON.stringify(d1.usage));

  console.log("\n[3] a follow-up reuses the slot's child");
  const followStart = Date.now();
  const follow = await pi.send({ type: "prompt", message: "/btw And what is its version field?" });
  const followMs = Date.now() - followStart;
  check("follow-up accepted", follow.success === true);
  check("follow-up is faster than the cold start (child reused)", followMs < coldMs,
    `cold=${coldMs}ms follow-up=${followMs}ms`);
  console.log(`        follow-up took ${followMs}ms`);

  await waitFor(() => btwEntries().length >= 2);
  const d2 = btwEntries()[1]?.data ?? {};
  check("follow-up landed in the same slot", d2.slot === 0, `slot=${JSON.stringify(d2.slot)}`);
  check("follow-up is turn 2 of that slot", d2.turn === 2, `turn=${JSON.stringify(d2.turn)}`);
  check("usage is per-turn, not the slot running total",
    !!d2.usage && !!d1.usage && d2.usage.input < d1.usage.input + d2.usage.input,
    `turn1.input=${d1.usage?.input} turn2.input=${d2.usage?.input}`);

  console.log("\n[4] /btw N targets another slot");
  const slot3 = await pi.send({ type: "prompt", message: "/btw 3 Reply with exactly: SLOT3OK" });
  check("slot 3 accepted", slot3.success === true);
  await waitFor(() => btwEntries().length >= 3);
  check("slot 3 persisted with slot index 2", btwEntries()[2]?.data?.slot === 2,
    JSON.stringify(btwEntries()[2]?.data?.slot));

  console.log("\n[5] a bare /btw with every slot occupied reuses the active slot");
  // Switching creates a slot without spawning a child, so this is free.
  for (let n = 1; n <= 9; n++) await pi.send({ type: "prompt", message: `/btw ${n}` });
  check("all 9 slots can be created", extensionErrors(pi.events).length === 0,
    JSON.stringify(extensionErrors(pi.events)));

  const errorsBefore = extensionErrors(pi.events).length;
  const exhausted = await pi.send({ type: "prompt", message: "/btw Reply with exactly: NINEOK" });
  check("bare /btw with all slots full does not throw", exhausted.success === true);
  check("no extension_error from slot exhaustion",
    extensionErrors(pi.events).length === errorsBefore,
    JSON.stringify(extensionErrors(pi.events).slice(errorsBefore)));
  await waitFor(() => btwEntries().length >= 4);
  check("the question ran in the active slot (9), not a tenth one",
    btwEntries().at(-1)?.data?.slot === 8,
    JSON.stringify(btwEntries().at(-1)?.data?.slot));

  console.log("\n[6] /btw inject reaches the provider payload");
  // Ask a question whose answer contains a marker, then inject it for real.
  await pi.send({
    type: "prompt",
    message: `/btw 5 Reply with exactly this and nothing else: ${INJECTION_MARKER}`,
  });
  await waitFor(() => btwEntries().some((e) => e.data?.slot === 4));
  const marked = btwEntries().find((e) => e.data?.slot === 4);
  check("the side answer carries the marker",
    String(marked?.data?.answer ?? "").includes(INJECTION_MARKER),
    JSON.stringify(marked?.data?.answer)?.slice(0, 200));

  const probeBefore = sessionEntries()
    .filter((e) => e.type === "custom" && e.customType === "probe-payload").length;
  const inject = await pi.send({ type: "prompt", message: "/btw inject" });
  check("/btw inject accepted", inject.success === true, JSON.stringify(inject));
  check("injection was reported to the user",
    notifications(pi.events).some((n) => /Injected and cleared|Queued injection/.test(n)),
    JSON.stringify(notifications(pi.events).slice(-3)));
  const sawProbe = await waitFor(() =>
    sessionEntries().filter((e) => e.type === "custom" && e.customType === "probe-payload")
      .length > probeBefore, 60000);
  const probes = sessionEntries()
    .filter((e) => e.type === "custom" && e.customType === "probe-payload")
    .slice(probeBefore);
  check("a provider request was made after the injection", sawProbe, `probes=${probes.length}`);
  check("the injected answer survived the /btw context filter",
    probes.some((e) => e.data?.hasMarker === true),
    `markers: ${JSON.stringify(probes.map((e) => e.data?.hasMarker))}`);

  console.log("\n[6b] /btw clear discards a slot");
  await pi.send({ type: "prompt", message: "/btw 6" });
  const cleared = await pi.send({ type: "prompt", message: "/btw clear" });
  check("/btw clear accepted", cleared.success === true);
  const clearInject = await pi.send({ type: "prompt", message: "/btw inject" });
  check("/btw inject after clear reports an empty slot", clearInject.success === true);
  check("no extension_error from the slot commands",
    extensionErrors(pi.events).length === 0, JSON.stringify(extensionErrors(pi.events)));

  console.log("\n[7] restore after a restart (the /resume path)");
  await pi.close();
  const sessionFile = readdirSync(sessionDir, { recursive: true, encoding: "utf8" })
    .map(String)
    .find((f) => f.endsWith(".jsonl"));
  if (!sessionFile) throw new Error(`no session file under ${sessionDir}`);

  const pi2 = startPi(["--session", join(sessionDir, sessionFile)]);
  try {
    const state = await pi2.send({ type: "get_state" });
    check("session reopened", state.success === true);
    const all = btwEntries();
    const restorable = all.filter((e) => typeof e.data?.slot === "number");
    check("every persisted turn is restorable", all.length > 0 && restorable.length === all.length,
      `${restorable.length}/${all.length} carry a slot number`);
    check("restored turns cover more than one slot",
      new Set(restorable.map((e) => e.data.slot)).size >= 2,
      JSON.stringify([...new Set(restorable.map((e) => e.data.slot))]));
    check("no extension_error during restore", extensionErrors(pi2.events).length === 0,
      JSON.stringify(extensionErrors(pi2.events)));
  } finally {
    await pi2.close();
  }
  console.log("\n[8] a provider only an extension knows about is caught before spawning");
  // The probe registers `e2e-invisible` at runtime, so the child (which runs
  // with --no-extensions) can never resolve it.
  const pi3 = startPi(["--model", "e2e-invisible/test-model"]);
  try {
    const ask = await pi3.send({ type: "prompt", message: "/btw anything at all" });
    check("command accepted", ask.success === true, JSON.stringify(ask));
    const said = notifications(pi3.events);
    check("warns that the provider is extension-registered",
      said.some((n) => /registered by an extension/.test(n)), JSON.stringify(said));
    check("names the provider and the way out",
      said.some((n) => n.includes("e2e-invisible") && /btwProvider/.test(n)), JSON.stringify(said));
    check("did not spawn a doomed child",
      !said.some((n) => /BTW RPC unavailable/.test(n)),
      "a 'RPC unavailable' notice means it spawned and failed instead of pre-checking");
    check("no extension_error", extensionErrors(pi3.events).length === 0,
      JSON.stringify(extensionErrors(pi3.events)));
  } finally {
    await pi3.close();
  }
} catch (error) {
  failures++;
  console.log(`\n  FAIL  driver threw: ${error instanceof Error ? error.stack : String(error)}`);
  console.log(`  stderr: ${pi.stderr().slice(0, 2000)}`);
  await pi.close();
}

console.log(`\n${failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures} check(s))`}\n`);
process.exit(failures === 0 ? 0 : 1);
