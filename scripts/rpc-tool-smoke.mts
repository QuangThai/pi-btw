import assert from "node:assert/strict";
import { BtwChild } from "../src/btw-child.ts";

function resolveSmokeModel(): { provider: string; modelId: string } {
  const configured = process.env.BTW_SMOKE_MODEL ??
    [process.env.PI_PROVIDER, process.env.PI_MODEL].filter(Boolean).join("/");
  const separator = configured.indexOf("/");
  if (separator <= 0 || separator === configured.length - 1) {
    throw new Error(
      "Set BTW_SMOKE_MODEL=provider/model (or run it inside Pi with PI_PROVIDER and PI_MODEL set).",
    );
  }
  return {
    provider: configured.slice(0, separator),
    modelId: configured.slice(separator + 1),
  };
}

const { provider, modelId } = resolveSmokeModel();
const child = new BtwChild(process.cwd(), provider, modelId);

try {
  await child.ready();
  const answer = await child.ask([
    "Use the read tool to read package.json in the current working directory.",
    "Do not guess or use prior context.",
    "Reply with exactly the package name and version from that file.",
  ].join("\n"));

  const messages = JSON.stringify(child.details.messages);
  assert.match(messages, /[\"']name[\"']\s*:\s*[\"']read[\"']/i,
    "The child completed without a recorded read tool call.");
  assert.match(answer, /@nguyenquangthai\/pi-btw/,
    "The answer did not contain the package name read from package.json.");

  console.log(JSON.stringify({
    ok: true,
    provider,
    modelId,
    tool: "read",
    answer,
    turns: child.details.usage.turns,
  }));
} finally {
  await child.stop();
}
