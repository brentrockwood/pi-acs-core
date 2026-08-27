import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function e2eProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env.PI_ACS_E2E_MODEL_URL;
  if (!baseUrl) throw new Error("PI_ACS_E2E_MODEL_URL is required");

  pi.registerProvider("acs-e2e", {
    name: "ACS end-to-end fixture",
    baseUrl,
    apiKey: "local-e2e-only",
    api: "openai-completions",
    models: [{
      id: "acs-e2e-model",
      name: "ACS end-to-end fixture model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_384,
      maxTokens: 1_024,
    }],
  });
}
