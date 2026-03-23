import path from 'node:path';

const isWindowsPath = (value: string) => /^[A-Za-z]:/.test(value) || value.includes('\\');

const trimTrailingSeparators = (value: string, root: string) => {
  const trimmed = value.replace(/[\\/]+$/, '');
  if (!trimmed) {
    return root.replace(/[\\/]+$/, '');
  }

  const normalizedRoot = root.replace(/[\\/]+$/, '');
  if (normalizedRoot && trimmed.length < normalizedRoot.length) {
    return normalizedRoot;
  }

  return trimmed;
};

export const normalizeWorkspacePath = (value: string) => {
  const input = value.trim();
  if (!input) {
    return '';
  }

  if (isWindowsPath(input)) {
    const normalized = path.win32.normalize(input.replace(/\//g, '\\'));
    return trimTrailingSeparators(normalized, path.win32.parse(normalized).root).toLowerCase();
  }

  const normalized = path.posix.normalize(input.replace(/\\/g, '/'));
  return trimTrailingSeparators(normalized, path.posix.parse(normalized).root);
};

export const sameWorkspacePath = (left: string, right: string) => {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
};

export const toClaudeProjectDirName = (rootPath: string) => {
  const normalized = normalizeWorkspacePath(rootPath).replace(/\//g, '\\');
  const match = normalized.match(/^([A-Za-z]):\\?(.*)$/);
  if (!match) {
    return null;
  }

  const drive = match[1].toUpperCase();
  const rest = match[2]
    .split('\\')
    .filter(Boolean)
    .join('-');

  return rest ? `${drive}--${rest}` : `${drive}--`;
};
