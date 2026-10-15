import { spawn } from 'node:child_process';

const baseUrl = 'http://127.0.0.1:3000';
const server = spawn(process.execPath, ['dist-server/server/src/index.js'], {
  cwd: process.cwd(), env: { ...process.env, MODU2_MODE: 'mock', NODE_ENV: 'test' }, stdio: 'inherit',
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ready = false;
for (let attempt = 0; attempt < 150; attempt++) {
  if (server.exitCode !== null) throw new Error(`Test API exited with ${server.exitCode}`);
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (response.ok) { ready = true; break; }
  } catch { /* server is still starting */ }
  await sleep(200);
}

let testExitCode = 1;
try {
  if (!ready) throw new Error('Timed out waiting for the local test API.');
  const cli = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], { stdio: 'inherit' });
  testExitCode = await new Promise((resolve, reject) => {
    cli.once('error', reject);
    cli.once('exit', code => resolve(code ?? 1));
  });
} catch (error) {
  console.error(error);
} finally {
  server.kill();
  if (server.exitCode === null) {
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(3000)]);
  }
}
process.exitCode = testExitCode;
