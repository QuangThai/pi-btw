/**
 * Point Pi's agent directory at a throwaway folder for this test process.
 *
 * Import this first in every test file. The extension's log, the settings it
 * persists, the registry probe, and every RPC child all resolve the agent
 * directory from PI_CODING_AGENT_DIR; without it a test run writes to the
 * developer's real ~/.pi/agent. It imports nothing from Pi on purpose, so the
 * variable is set before any Pi module loads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-btw-test-agent-"));
process.env.PI_CODING_AGENT_DIR = TEST_AGENT_DIR;

process.on("exit", () => {
  try {
    rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
  } catch {
    // A child that has not released its files yet; the OS temp dir cleans up.
  }
});
