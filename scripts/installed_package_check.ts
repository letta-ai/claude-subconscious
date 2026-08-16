import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'claude-subconscious-install-'));

try {
  const packOutput = execFileSync(
    npm,
    ['pack', '--json', '--pack-destination', temporaryRoot],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(packOutput) as Array<{ filename: string }>;
  const tarball = join(temporaryRoot, filename);
  const consumerRoot = join(temporaryRoot, 'consumer');

  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ name: 'installed-package-check', private: true }, null, 2),
  );
  execFileSync(
    npm,
    ['install', '--no-audit', '--no-fund', tarball],
    { cwd: consumerRoot, stdio: 'inherit' },
  );

  const installedRoot = join(consumerRoot, 'node_modules', 'claude-subconscious');
  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    engines?: Record<string, string>;
  };

  if (installedPackage.engines?.node !== '>=22.19.0') {
    throw new Error('Installed package does not require Node >=22.19.0');
  }
  if (!installedPackage.dependencies?.['@letta-ai/letta-agent-sdk']) {
    throw new Error('Installed package does not declare the Letta Agent SDK');
  }

  const probe = join(installedRoot, 'scripts', 'installed_sdk_probe.ts');
  writeFileSync(
    probe,
    [
      "import { LettaAgentClient } from '@letta-ai/letta-agent-sdk';",
      "if (typeof LettaAgentClient !== 'function') throw new Error('SDK export unavailable');",
      "const client = new LettaAgentClient({ backend: 'local', appServer: { harnessBackend: 'api' } });",
      "for (const allowedTools of [[], ['Read', 'Grep', 'Glob', 'web_search', 'fetch_webpage'], undefined]) {",
      "  const session = client.resumeSession('conversation-installed-package-check', {",
      "    permissionMode: 'unrestricted',",
      '    cwd: process.cwd(),',
      '    skillSources: [],',
      '    stateless: true,',
      '    ...(allowedTools === undefined ? {} : { allowedTools }),',
      '  });',
      '  session.close();',
      '}',
      "console.log('installed-agent-sdk-ok');",
      '',
    ].join('\n'),
  );

  const executionRoot = join(temporaryRoot, 'unrelated-working-directory');
  const shimRoot = join(temporaryRoot, 'command-shims');
  mkdirSync(executionRoot);
  mkdirSync(shimRoot);
  if (process.platform === 'win32') {
    writeFileSync(join(shimRoot, 'npx.cmd'), '@exit /b 97\r\n');
  } else {
    const npxShim = join(shimRoot, 'npx');
    writeFileSync(npxShim, '#!/bin/sh\nexit 97\n');
    chmodSync(npxShim, 0o755);
  }

  const output = execFileSync(
    process.execPath,
    [join(installedRoot, 'hooks', 'silent-npx.cjs'), 'tsx', probe],
    {
      cwd: executionRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimRoot}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
    },
  );
  if (!output.includes('installed-agent-sdk-ok')) {
    throw new Error('Installed hook launcher did not execute the Agent SDK probe');
  }

  const workerResult = spawnSync(
    process.execPath,
    [
      join(installedRoot, 'hooks', 'silent-npx.cjs'),
      'tsx',
      join(installedRoot, 'scripts', 'send_worker_sdk.ts'),
    ],
    {
      cwd: executionRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${shimRoot}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
    },
  );
  if (workerResult.status !== 1) {
    throw new Error(`Installed SDK worker returned ${String(workerResult.status)} without a payload`);
  }
  if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(workerResult.stderr)) {
    throw new Error(`Installed SDK worker could not resolve a runtime dependency:\n${workerResult.stderr}`);
  }

  console.log('Installed hook launcher and SDK worker resolved package runtime dependencies.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
