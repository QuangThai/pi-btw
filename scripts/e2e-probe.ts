/**
 * Probe extension for the /btw end-to-end script.
 *
 * Records whether a marker survives into the payload actually sent to the
 * provider. That is the only way to prove the /btw context handler does not
 * strip injected answers, since the filter runs between the session and the
 * provider request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INJECTION_MARKER = "MARKER-BTWINJECT42";

/**
 * A provider that exists only because an extension registered it.
 *
 * The /btw child runs with `--no-extensions`, so this provider cannot exist
 * inside it. That is the exact failure class seen in the wild with custom
 * Codex providers, and it is what the pre-flight check must catch.
 */
export const INVISIBLE_PROVIDER = "e2e-invisible";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(INVISIBLE_PROVIDER, {
    // Unroutable on purpose: the request must never get this far.
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "e2e-not-a-real-key",
    api: "openai-completions",
    models: [{
      id: "test-model",
      name: "E2E Invisible Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  });

  pi.on("before_provider_request", (event) => {
    let hasMarker = false;
    try {
      hasMarker = JSON.stringify(event.payload).includes(INJECTION_MARKER);
    } catch {
      hasMarker = false;
    }
    pi.appendEntry("probe-payload", { hasMarker });
  });
}
