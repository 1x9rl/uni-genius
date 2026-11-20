import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function start(label, args) {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: process.env,
  });
  children.push(child);
  child.on('error', (error) => {
    console.error(`[UNI GENIUS] Could not start ${label}:`, error);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[UNI GENIUS] ${label} stopped (code: ${code}, signal: ${signal}).`);
      shutdown(code || 1);
    }
  });
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Start the Express API and Vite together. Vite proxies /api to Express on port 8787.
start('API server', ['--env-file-if-exists=.env', 'index.mjs']);
start('Vite development server', ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0']);
