/**
 * Search the Subconscious agent's memory blocks and archival memory.
 *
 * Usage: npx tsx scripts/recall.ts <search query>
 *
 * Queries:
 * 1. Memory blocks - text search across all 8 named blocks
 * 2. Archival memory - vector similarity search via Letta API
 */

import { fetchAgent, getApiKey } from './conversation_utils.js';
import { getAgentId } from './agent_config.js';
import { buildLettaApiUrl } from './letta_api_url.js';

const query = process.argv.slice(2).join(' ');

if (!query) {
  console.log('Usage: npx tsx scripts/recall.ts <search query>');
  console.log('Example: npx tsx scripts/recall.ts authentication patterns');
  process.exit(0);
}

async function searchMemoryBlocks(apiKey: string, agentId: string, query: string) {
  const agent = await fetchAgent(apiKey, agentId);
  const blocks = (agent as any).blocks || (agent as any).memory?.blocks || [];
  const lowerQuery = query.toLowerCase();
  const results: Array<{ label: string; matches: string[] }> = [];

  for (const block of blocks) {
    const label = block.label || block.name || 'unknown';
    const value = block.value || block.content || '';
    if (value.toLowerCase().includes(lowerQuery)) {
      const lines = value.split('\n');
      const matching = lines.filter((l: string) => l.toLowerCase().includes(lowerQuery));
      results.push({ label, matches: matching.slice(0, 5) });
    }
  }

  return results;
}

async function searchArchivalMemory(apiKey: string, agentId: string, query: string) {
  const url = buildLettaApiUrl(`/agents/${agentId}/archival`, {
    query,
    limit: '5',
  });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const entries = await response.json();
  if (!Array.isArray(entries)) return [];

  return entries.map((entry: any) => {
    const text = entry.text || entry.content || JSON.stringify(entry);
    return text.slice(0, 200);
  });
}

async function main() {
  const apiKey = process.env.LETTA_API_KEY || '';
  if (!apiKey) {
    console.error('LETTA_API_KEY not set. Run the plugin setup first.');
    process.exit(1);
  }

  let agentId: string;
  try {
    agentId = await getAgentId(apiKey, () => {});
  } catch {
    console.error('Could not resolve agent ID. Is the Subconscious plugin configured?');
    process.exit(1);
  }

  console.log(`Searching Subconscious memory for: ${query}\n`);

  // Search memory blocks
  console.log('=== Memory Blocks ===');
  try {
    const blockResults = await searchMemoryBlocks(apiKey, agentId, query);
    if (blockResults.length === 0) {
      console.log('  No matches in memory blocks.');
    } else {
      for (const result of blockResults) {
        console.log(`\n  [${result.label}]`);
        for (const match of result.matches) {
          console.log(`    ${match.trim()}`);
        }
      }
    }
  } catch (err) {
    console.log(`  Error searching blocks: ${err}`);
  }

  console.log('\n=== Archival Memory ===');
  try {
    const archivalResults = await searchArchivalMemory(apiKey, agentId, query);
    if (archivalResults.length === 0) {
      console.log('  No archival memory matches.');
    } else {
      archivalResults.forEach((text: string, i: number) => {
        console.log(`  ${i + 1}. ${text}`);
        if (text.length >= 200) console.log('     ...');
      });
    }
  } catch (err) {
    console.log(`  Error searching archival: ${err}`);
  }
}

main();
