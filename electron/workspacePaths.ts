import path from 'node:path';

const isWindowsPath = (value: string) => /^[A-Za-z]:/.test(value) || value.includes('\\');

const normalizeWindowsPathPreserveCase = (value: string) => {
  const normalized = path.win32.normalize(value.replace(/\//g, '\\'));
  return trimTrailingSeparators(normalized, path.win32.parse(normalized).root);
};

const buildClaudeProjectDirName = (
  normalizedPath: string,
  mapSegment: (segment: string) => string = (segment) => segment,
) => {
  const normalized = normalizedPath.replace(/\//g, '\\');
  const match = normalized.match(/^([A-Za-z]):\\?(.*)$/);
  if (!match) {
    return null;
  }

  const drive = match[1].toUpperCase();
  const rest = match[2]
    .split('\\')
    .filter(Boolean)
    .map((segment) => mapSegment(segment))
    .join('-');

  return rest ? `${drive}--${rest}` : `${drive}--`;
};

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

export const isWorkspaceWithinProjectTree = (projectRoot: string, workspace: string) => {
  const normalizedProjectRoot = normalizeWorkspacePath(projectRoot);
  const normalizedWorkspace = normalizeWorkspacePath(workspace);
  if (!normalizedProjectRoot || !normalizedWorkspace) {
    return false;
  }

  if (normalizedProjectRoot === normalizedWorkspace) {
    return true;
  }

  const separator = normalizedProjectRoot.includes('\\') ? '\\' : '/';
  return normalizedWorkspace.startsWith(`${normalizedProjectRoot}${separator}`);
};

export const toClaudeProjectDirName = (rootPath: string) => {
  if (!isWindowsPath(rootPath)) {
    return null;
  }

  return buildClaudeProjectDirName(
    normalizeWindowsPathPreserveCase(rootPath),
    (segment) => segment.replace(/_/g, '-'),
  );
};

export const getClaudeProjectDirNameCandidates = (rootPath: string) => {
  if (!isWindowsPath(rootPath)) {
    return [] as string[];
  }

  const preservedCase = normalizeWindowsPathPreserveCase(rootPath);
  const normalizedLegacy = normalizeWorkspacePath(rootPath).replace(/\//g, '\\');
  const candidates = [
    buildClaudeProjectDirName(preservedCase, (segment) => segment.replace(/_/g, '-')),
    buildClaudeProjectDirName(preservedCase),
    buildClaudeProjectDirName(normalizedLegacy),
    buildClaudeProjectDirName(normalizedLegacy, (segment) => segment.replace(/_/g, '-')),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(candidates)];
};
