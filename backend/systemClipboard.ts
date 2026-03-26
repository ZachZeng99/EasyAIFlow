import { spawn } from 'node:child_process';

const runClipboardCommand = (command: string, args: string[], text: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';

    child.on('error', reject);
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Clipboard command exited with code ${code ?? 'unknown'}.`));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(text);
  });

export const writeTextToSystemClipboard = async (value: string) => {
  if (process.platform === 'win32') {
    await runClipboardCommand(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      value,
    );
    return;
  }

  if (process.platform === 'darwin') {
    await runClipboardCommand('pbcopy', [], value);
    return;
  }

  try {
    await runClipboardCommand('xclip', ['-selection', 'clipboard'], value);
  } catch {
    await runClipboardCommand('xsel', ['--clipboard', '--input'], value);
  }
};
