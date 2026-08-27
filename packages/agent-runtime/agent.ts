import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { DEFAULT_MODEL } from "../core/index.js";

export interface CreateObserverAgentOptions {
  apiKey: string;
  model?: string;
  client?: LettaAgentClient;
}

export async function createObserverAgent(
  options: CreateObserverAgentOptions,
): Promise<string> {
  const client =
    options.client ??
    new LettaAgentClient({
      backend: "cloud",
      apiKey: options.apiKey,
    });
  return await client.createAgent({
    name: "Subconscious",
    description: "Quiet observer for coding-agent sessions.",
    hidden: true,
    model: options.model ?? DEFAULT_MODEL,
    tags: ["origin:subconscious"],
    memfs: true,
    baseTools: [],
    skillSources: [],
  });
}
