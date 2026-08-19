import { claudeCodeAdapter } from "../adapter-claude-code/index.js";
import { codexAdapter } from "../adapter-codex/index.js";
import { lettaCodeAdapter } from "../adapter-letta-code/index.js";
import type { HarnessAdapter, HarnessId } from "../core/index.js";

const adapters = new Map<HarnessId, HarnessAdapter>([
  [claudeCodeAdapter.id, claudeCodeAdapter],
  [codexAdapter.id, codexAdapter],
  [lettaCodeAdapter.id, lettaCodeAdapter],
]);

export function getAdapter(id: HarnessId): HarnessAdapter {
  const adapter = adapters.get(id);
  if (!adapter) throw new Error(`Unsupported harness adapter: ${id}`);
  return adapter;
}

export function listAdapters(): HarnessAdapter[] {
  return [...adapters.values()];
}
