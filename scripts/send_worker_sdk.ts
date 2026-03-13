#!/usr/bin/env npx tsx
/**
 * SDK-based background worker that sends messages to Letta via Letta Code SDK.
 * Gives the Subconscious agent client-side tool access (Read, Grep, Glob, etc.).
 *
 * Spawned by send_messages_to_letta.ts as a detached process.
 * Falls back gracefully if the SDK is not available.
 *
 * Usage: npx tsx send_worker_sdk.ts <payload_file>
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
const TEMP_STATE_DIR = path.join(os.tmpdir(), `letta-claude-sync-${uid}`);
const LOG_FILE = path.join(TEMP_STATE_DIR, 'send_worker_sdk.log');

interface SdkPayload {
  agentId: string;
  sessionId: string;
  message: string;
  stateFile: string;
  newLastProcessedIndex: number;
  cwd: string;
  sdkToolsMode: 'read-only' | 'full';
}

function log(message: string): void {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

async function sendViaSdk(payload: SdkPayload): Promise<boolean> {
  log(`Loading Letta Code SDK...`);

  // Dynamic import so this file can be parsed even if SDK isn't installed
  const { resumeSession } = await import('@letta-ai/letta-code-sdk');

  // Configure tool restrictions based on mode
  const readOnlyTools = ['Read', 'Grep', 'Glob', 'web_search', 'fetch_webpage'];
  const blockedTools = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

  const sessionOptions: Record<string, unknown> = {
    disallowedTools: blockedTools,
    permissionMode: 'bypassPermissions',
    cwd: payload.cwd,
    skillSources: [],          // Sub doesn't need skills
    systemInfoReminder: false, // reduce noise
    sleeptime: { trigger: 'off' }, // don't recurse sleeptime
  };

  if (payload.sdkToolsMode === 'read-only') {
    sessionOptions.allowedTools = readOnlyTools;
  }
  // 'full' mode: no allowedTools restriction (all tools available)

  log(`Creating SDK session for agent ${payload.agentId} (mode: ${payload.sdkToolsMode})`);
  log(`  cwd: ${payload.cwd}`);
  log(`  allowedTools: ${payload.sdkToolsMode === 'read-only' ? readOnlyTools.join(', ') : 'all'}`);

  const session = resumeSession(payload.agentId, sessionOptions);

  try {
    log(`Sending message (${payload.message.length} chars)...`);
    await session.send(payload.message);

    // Stream and capture the response
    let assistantResponse = '';
    let messageCount = 0;

    for await (const msg of session.stream()) {
      messageCount++;
      if (msg.type === 'assistant' && msg.content) {
        assistantResponse += msg.content;
        log(`  Assistant chunk: ${msg.content.substring(0, 100)}...`);
      }
    }

    log(`Stream complete: ${messageCount} messages, assistant response: ${assistantResponse.length} chars`);

    // The SDK session sends the message to the Letta agent which processes it
    // and generates a response. The response is automatically stored in the
    // agent's conversation history on the Letta server. The existing
    // pretool_sync / sync_letta_memory flow will pick it up and inject it
    // into Claude's context on the next prompt.

    return true;

  } finally {
    session.close();
    log('SDK session closed');
  }
}

async function main(): Promise<void> {
  const payloadFile = process.argv[2];

  if (!payloadFile) {
    log('ERROR: No payload file specified');
    process.exit(1);
  }

  log('='.repeat(60));
  log(`SDK Worker started with payload: ${payloadFile}`);

  try {
    if (!fs.existsSync(payloadFile)) {
      log(`ERROR: Payload file not found: ${payloadFile}`);
      process.exit(1);
    }

    const payload: SdkPayload = JSON.parse(fs.readFileSync(payloadFile, 'utf-8'));
    log(`Loaded payload for session ${payload.sessionId}`);

    const success = await sendViaSdk(payload);

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
    log('SDK Worker completed successfully');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      log(`Stack: ${error.stack}`);
    }
    process.exit(1);
  }
}

main();
