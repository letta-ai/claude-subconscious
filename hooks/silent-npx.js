#!/usr/bin/env node
const { spawn } = require('child_process');

// Detect platform
const isWindows = process.platform === 'win32';

// Run npx with the remaining arguments
const child = spawn('npx', process.argv.slice(2), {
  windowsHide: isWindows,  // Hide console window on Windows only
  stdio: 'inherit',        // Pass through stdout/stderr
  shell: isWindows         // Use shell on Windows to resolve npx.cmd
});

// Forward exit code
child.on('exit', (code) => {
  process.exit(code || 0);
});

// Handle errors
child.on('error', (err) => {
  console.error('Failed to start subprocess:', err);
  process.exit(1);
});
