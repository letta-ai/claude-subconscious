#!/usr/bin/env npx tsx
/**
 * Background worker that sends messages to Letta
 * Spawned by send_messages_to_letta.ts as a detached process
 *
 * Usage: npx tsx send_worker.ts <payload_file>
 */

import * as fs from 'fs';
import * as path from 'path';

const LETTA_API_BASE = 'https://api.letta.com/v1';
const LOG_FILE = '/tmp/letta-claude-sync/send_worker.log';

interface Payload {
  apiKey: string;
  conversationId: string;
  sessionId: string;
  message: string;
  stateFile: string;
  newLastProcessedIndex: number;
}

function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function sendToLetta(payload: Payload): Promise<boolean> {
  const url = `${LETTA_API_BASE}/conversations/${payload.conversationId}/messages`;

  log(`Sending to conversation ${payload.conversationId} (${payload.message.length} chars)`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${payload.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'system', content: payload.message }],
    }),
  });

  log(`Response status: ${response.status}`);

  if (response.status === 409) {
    log('Conversation busy (409) - will retry on next Stop');
    return false;
  }

  if (!response.ok) {
    const errorText = await response.text();
    log(`Error: ${errorText}`);
    throw new Error(`Letta API error (${response.status}): ${errorText}`);
  }

  // Consume the stream to completion
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = new TextDecoder().decode(value);
        log(`Chunk: ${chunk.substring(0, 100)}...`);
      }
    } finally {
      reader.cancel();
    }
  }

  log('Message sent successfully');
  return true;
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];

  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: Payload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
    log(`Loaded payload for session ${payload.sessionId}`);

    const success = await sendToLetta(payload);

    if (success) {
      // Update state file
      const state = JSON.parse(fs.readFileSync(payload.stateFile, 'utf-8'));
      state.lastProcessedIndex = payload.newLastProcessedIndex;
      fs.writeFileSync(payload.stateFile, JSON.stringify(state, null, 2));
      log(`Updated state: lastProcessedIndex=${payload.newLastProcessedIndex}`);
    }

    // Clean up payload file
    fs.unlinkSync(payloadFile);
    log('Cleaned up payload file');
    log('Worker completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    process.exit(1);
  }
}

main();
