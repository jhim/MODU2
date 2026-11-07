import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { mockAuthServer } from './mock-auth.mjs';

const baseUrl = 'http://127.0.0.1:3000';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const explicitSpecs = args.filter(arg => arg.endsWith('.spec.ts'));
const testArgs = args.filter(arg => !arg.endsWith('.spec.ts'));
const allSpecs = explicitSpecs.length
  ? explicitSpecs
  : (await readdir(path.join(process.cwd(), 'tests/e2e')))
    .filter(file => file.endsWith('.spec.ts'))
    .map(file => `tests/e2e/${file}`)
    .sort();
const adminSpecs = allSpecs.filter(spec => path.basename(spec) === 'prompt-admin.spec.ts');
const legacySpecs = allSpecs.filter(spec => path.basename(spec) !== 'prompt-admin.spec.ts');

function run(command, commandArgs, env) {
  const child = spawn(command, commandArgs, { cwd: process.cwd(), env, stdio: 'inherit' });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

async function runGroup(label, specs, withMockAuth) {
  if (specs.length === 0) return 0;

  // Vite embeds these values at build time, so each auth context gets its own build.
  // Explicit empty values override any local .env values for the legacy test group.
  const env = {
    ...process.env,
    MODU2_MODE: 'mock',
    NODE_ENV: 'test',
    SUPABASE_URL: '',
    SUPABASE_ANON_KEY: '',
    VITE_SUPABASE_URL: '',
    VITE_SUPABASE_ANON_KEY: '',
  };
  let authListening = false;
  let server;
  let exitCode = 1;

  try {
    if (withMockAuth) {
      await new Promise((resolve, reject) => {
        mockAuthServer.once('error', reject);
        mockAuthServer.listen(0, '127.0.0.1', resolve);
      });
      authListening = true;
      const address = mockAuthServer.address();
      if (!address || typeof address === 'string') throw new Error('Mock Auth server address is unavailable.');
      const authUrl = `http://127.0.0.1:${address.port}`;
      env.SUPABASE_URL = authUrl;
      env.SUPABASE_ANON_KEY = 'e2e-anon-key';
      env.VITE_SUPABASE_URL = authUrl;
      env.VITE_SUPABASE_ANON_KEY = 'e2e-anon-key';
    }

    console.log(`\n[E2E] ${label}: building with ${withMockAuth ? 'Mock Auth enabled' : 'Auth disabled'}`);
    const npmPath = process.env.npm_execpath;
    if (!npmPath) throw new Error('npm_execpath is unavailable; run this script through npm run test:e2e.');
    const buildExitCode = await run(process.execPath, [npmPath, 'run', 'build'], env);
    if (buildExitCode !== 0) return buildExitCode;

    server = spawn(process.execPath, ['dist-server/server/src/index.js'], {
      cwd: process.cwd(), env, stdio: 'inherit',
    });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (server.exitCode !== null) throw new Error(`Test API exited with ${server.exitCode}`);
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* server is still starting */ }
      await sleep(200);
    }
    if (!ready) throw new Error(`Timed out waiting for the local test API (${label}).`);

    exitCode = await run(process.execPath, [
      'node_modules/@playwright/test/cli.js', 'test', ...specs, ...testArgs,
    ], env);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    if (server && server.exitCode === null) {
      server.kill();
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
    }
    if (authListening) await new Promise(resolve => mockAuthServer.close(resolve));
  }

  return exitCode;
}

// Keep legacy content-management flows in their original no-Supabase-Auth context.
// Only the admin spec receives the isolated Mock Auth environment.
const legacyExitCode = await runGroup('existing E2E', legacySpecs, false);
const adminExitCode = legacyExitCode === 0 ? await runGroup('admin E2E', adminSpecs, true) : 1;
process.exitCode = legacyExitCode || adminExitCode;
