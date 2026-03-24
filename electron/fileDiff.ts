import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DiffPayload } from '../src/data/types.js';

const execFileAsync = promisify(execFile);

type RepoRootResolver = (candidatePath: string) => Promise<string | null>;
type ExecFileAsyncFn = typeof execFileAsync;
type ReadTextFile = (filePath: string, encoding: 'utf8') => Promise<string>;

const normalizeFilePath = (filePath: string) => path.normalize(filePath.replace(/\//g, path.sep));

const isPathInside = (rootPath: string, targetPath: string) => {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};

const resolveGitRoot = async (
  candidatePath: string,
  execFileFn: ExecFileAsyncFn = execFileAsync,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileFn('git', ['-C', candidatePath, 'rev-parse', '--show-toplevel']);
    const repoRoot = stdout.trim();
    return repoRoot ? path.normalize(repoRoot) : null;
  } catch {
    return null;
  }
};

export const resolveDiffTarget = async (
  cwd: string,
  filePath: string,
  resolveRepoRoot: RepoRootResolver,
) => {
  const normalizedPath = normalizeFilePath(filePath);
  const absolutePath = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(cwd, normalizedPath);
  const candidates = Array.from(new Set([path.dirname(absolutePath), cwd]));

  for (const candidatePath of candidates) {
    const repoRoot = await resolveRepoRoot(candidatePath);
    if (!repoRoot || !isPathInside(repoRoot, absolutePath)) {
      continue;
    }

    return {
      normalizedPath,
      absolutePath,
      gitCwd: repoRoot,
      gitPath: path.relative(repoRoot, absolutePath) || path.basename(absolutePath),
    };
  }

  return {
    normalizedPath,
    absolutePath,
  };
};

export const getFileDiff = async (
  cwd: string,
  filePath: string,
  execFileFn: ExecFileAsyncFn = execFileAsync,
  readFileFn: ReadTextFile = readFile,
): Promise<DiffPayload> => {
  const target = await resolveDiffTarget(cwd, filePath, (candidatePath) => resolveGitRoot(candidatePath, execFileFn));

  if (target.gitCwd && target.gitPath) {
    try {
      const { stdout: statusStdout } = await execFileFn(
        'git',
        ['status', '--porcelain', '--', target.gitPath],
        { cwd: target.gitCwd },
      );
      const statusLine = statusStdout.split(/\r?\n/).find(Boolean) ?? '';

      if (statusLine.startsWith('??')) {
        const preview = await readFileFn(target.absolutePath, 'utf8');
        return {
          filePath: target.normalizedPath,
          kind: 'untracked',
          content: `# Untracked file: ${target.normalizedPath}\n\n${preview.slice(0, 12000)}`,
        };
      }

      const { stdout: diffStdout } = await execFileFn('git', ['diff', '--', target.gitPath], { cwd: target.gitCwd });
      if (diffStdout.trim()) {
        return {
          filePath: target.normalizedPath,
          kind: 'git',
          content: diffStdout,
        };
      }

      const { stdout: cachedStdout } = await execFileFn('git', ['diff', '--cached', '--', target.gitPath], {
        cwd: target.gitCwd,
      });
      if (cachedStdout.trim()) {
        return {
          filePath: target.normalizedPath,
          kind: 'git',
          content: cachedStdout,
        };
      }
    } catch {
      // Fall back to a file preview when git lookup fails.
    }
  }

  try {
    const preview = await readFileFn(target.absolutePath, 'utf8');
    return {
      filePath: target.normalizedPath,
      kind: 'preview',
      content: preview.slice(0, 12000),
    };
  } catch {
    return {
      filePath: target.normalizedPath,
      kind: 'missing',
      content: 'No diff available for this file.',
    };
  }
};
