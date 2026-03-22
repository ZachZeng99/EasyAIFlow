import { execFileSync } from 'node:child_process';

const port = 4173;

const run = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return error.stdout?.toString?.() ?? '';
  }
};

const parsePidsFromNetstat = (output) => {
  const lines = output.split(/\r?\n/);
  const pids = new Set();

  for (const line of lines) {
    if (!line.includes(`:${port}`) || !line.includes('LISTENING')) {
      continue;
    }

    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && /^\d+$/.test(pid)) {
      pids.add(pid);
    }
  }

  return [...pids];
};

const netstatOutput = run('netstat', ['-ano', '-p', 'tcp']);
const pids = parsePidsFromNetstat(netstatOutput);

for (const pid of pids) {
  try {
    execFileSync('taskkill', ['/PID', pid, '/F'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`Freed port ${port} by stopping PID ${pid}`);
  } catch (error) {
    const stderr = error.stderr?.toString?.() ?? '';
    if (!stderr.includes('not found')) {
      console.warn(`Could not stop PID ${pid}: ${stderr || error.message}`);
    }
  }
}
