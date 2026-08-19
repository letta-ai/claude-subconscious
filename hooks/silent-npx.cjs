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

/**
 * Map a TypeScript source path to its compiled build output, when one exists.
 *
 * Running the build skips tsx's TypeScript pipeline entirely. That is worth
 * roughly 200ms per invocation, which matters once hooks run before and after
 * every tool call rather than once a turn.
 */
function compiledEquivalent(sourcePath, pluginRoot) {
  if (typeof sourcePath !== 'string' || !sourcePath.endsWith('.ts')) return null;
  const relative = path.relative(pluginRoot, sourcePath);
  if (!relative || relative.startsWith('..')) return null;
  const compiled = path.join(pluginRoot, 'dist', relative.replace(/\.ts$/, '.js'));
  return fs.existsSync(compiled) ? compiled : null;
}

if (args[0] === 'tsx') {
  let scriptArgs = args.slice(1); // everything after 'tsx'
  const pluginRoot = path.resolve(__dirname, '..');

  // If CLAUDE_PLUGIN_ROOT is empty, an absolute-looking plugin path does not
  // exist. Resolve the requested file from the plugin root.
  scriptArgs = scriptArgs.map(arg => {
    if (!fs.existsSync(arg) && (arg.includes('/scripts/') || arg.includes('/packages/'))) {
      const marker = arg.includes('/packages/') ? '/packages/' : '/scripts/';
      const relative = arg.slice(arg.indexOf(marker) + 1);
      const resolved = path.join(pluginRoot, relative);
      if (fs.existsSync(resolved)) return resolved;
    }
    return arg;
  });
  const tsxCli = path.join(pluginRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const silentLauncher = path.join(__dirname, 'silent-launcher.exe');
  const compiled = compiledEquivalent(scriptArgs[0], pluginRoot);

  if (compiled) {
    // Compiled build available: run it on plain node and skip tsx.
    const compiledArgs = [compiled, ...scriptArgs.slice(1)];
    if (isWindows && fs.existsSync(silentLauncher)) {
      child = spawn(silentLauncher, ['node', ...compiledArgs], {
        stdio: 'inherit',
        windowsHide: true,
      });
    } else {
      child = spawn(process.execPath, compiledArgs, {
        stdio: 'inherit',
        windowsHide: isWindows,
      });
    }
  } else if (isWindows) {
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
