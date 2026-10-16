import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SECRET_FIELD = /^(?:authorization|password|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret)$/i;
const sizes = new Map<string, number>();

/** Opt-in diagnostic capture for isolated integration probes; never enabled by default. */
export const captureProviderFrame = (provider: string, sessionId: string, frame: unknown) => {
  const directory = process.env.EASYAIFLOW_PROTOCOL_CAPTURE_DIR;
  if (!directory) return;
  try {
    const id = createHash('sha256').update(sessionId).digest('hex').slice(0, 20);
    const filename = path.join(directory, `${provider}-${id}.jsonl`);
    let size = sizes.get(filename);
    if (size === undefined) {
      mkdirSync(directory, { recursive: true });
      try { size = statSync(filename).size; } catch { size = 0; }
    }
    if (size >= 16 * 1024 * 1024) return;
    const line = JSON.stringify({ formatVersion: 1, provider, sessionId, capturedAt: new Date().toISOString(), frame },
      (key, value) => SECRET_FIELD.test(key) ? '[redacted]' : value) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) return;
    appendFileSync(filename, line, 'utf8');
    sizes.set(filename, size + Buffer.byteLength(line));
  } catch {
    // Diagnostics must never interrupt a running task or leak frame contents.
  }
};
