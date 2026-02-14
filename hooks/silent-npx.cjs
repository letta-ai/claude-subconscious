#!/usr/bin/env node
/**
 * Cross-platform launcher for Claude Subconscious hooks.
 *
 * On Windows: delegates to silent-launcher.exe which creates a headless
 * PseudoConsole (ConPTY) + CREATE_NO_WINDOW to eliminate console window
 * flashes on Windows 11 / Windows Terminal.
 *
 * On other platforms: runs tsx directly via node — no console issue.
 *
 * Called from hooks.json as:
 *   node hooks/silent-npx.cjs tsx scripts/<script>.ts
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
const args = process.argv.slice(2); // e.g. ['tsx', 'path/to/script.ts']

let child;

if (args[0] === 'tsx') {
  const scriptArgs = args.slice(1); // everything after 'tsx'
  const pluginRoot = path.resolve(__dirname, '..');
  const tsxCli = path.join(pluginRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  if (isWindows) {
    const silentLauncher = path.join(__dirname, 'silent-launcher.exe');

    if (fs.existsSync(silentLauncher) && fs.existsSync(tsxCli)) {
      // PseudoConsole + CREATE_NO_WINDOW: popup-free execution
      child = spawn(silentLauncher, ['node', tsxCli, ...scriptArgs], {
        stdio: 'inherit',
        windowsHide: true,
      });
    } else if (fs.existsSync(tsxCli)) {
      // Fallback: run tsx CLI directly (may flash on Windows Terminal)
      child = spawn(process.execPath, [tsxCli, ...scriptArgs], {
        stdio: 'inherit',
        windowsHide: true,
      });
    } else {
      // Last resort: npx through shell
      child = spawn('npx', args, {
        stdio: 'inherit',
        shell: true,
        windowsHide: true,
      });
    }
  } else {
    // Non-Windows: no console window issues
    if (fs.existsSync(tsxCli)) {
      child = spawn(process.execPath, [tsxCli, ...scriptArgs], {
        stdio: 'inherit',
      });
    } else {
      child = spawn('npx', args, {
        stdio: 'inherit',
      });
    }
  }
} else {
  // Non-tsx command: use npx
  child = spawn('npx', args, {
    stdio: 'inherit',
    shell: isWindows,
    windowsHide: isWindows,
  });
}

child.on('exit', (code) => {
  process.exit(code || 0);
});

child.on('error', (err) => {
  console.error('Failed to start subprocess:', err);
  process.exit(1);
});
