// Preload: delivers stdin from temp file via unshift, captures stdout to temp file.
// Loaded via --require in the node command line.
// Used with PseudoConsole + CREATE_NO_WINDOW where pipe I/O is not available.
'use strict';

const fs = require('fs');
const stdoutFile = process.env.SL_STDOUT_FILE;
const stdinFile = process.env.SL_STDIN_FILE;

// --- STDIN: Read from temp file, unshift onto existing Socket ---
if (stdinFile) {
  try {
    const data = fs.readFileSync(stdinFile);
    if (data.length > 0) {
      const sock = process.stdin;
      sock.pause();
      sock.unshift(data);
      process.nextTick(() => sock.push(null));
    }
  } catch (e) { /* stdin file may not exist */ }
}

// --- STDOUT/STDERR: Capture all writes to temp file ---
if (stdoutFile) {
  try {
    const fd = fs.openSync(stdoutFile, 'a');

    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function(chunk, encoding, callback) {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        fs.writeSync(fd, buf);
      } catch (e) { /* ignore write errors */ }
      return origWrite(chunk, encoding, callback);
    };

    const origErrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = function(chunk, encoding, callback) {
      try {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
        fs.writeSync(fd, buf);
      } catch (e) { /* ignore write errors */ }
      return origErrWrite(chunk, encoding, callback);
    };

    process.on('exit', () => {
      try { fs.closeSync(fd); } catch(e) {}
    });
  } catch (e) { /* stdout setup error */ }
}
