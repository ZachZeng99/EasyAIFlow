import path from 'node:path';

const normalizeWindowsPath = (value: string) => value.replace(/\//g, '\\').replace(/\\+$/, '');

const toHomeRule = (targetPath: string, homeDir: string) => {
  const normalizedTarget = normalizeWindowsPath(targetPath).toLowerCase();
  const normalizedHome = normalizeWindowsPath(homeDir).toLowerCase();
  if (!normalizedTarget.startsWith(normalizedHome)) {
    return null;
  }

  const relative = targetPath.slice(homeDir.length).replace(/^\\+/, '').replace(/\\/g, '/');
  const directory = relative.split('/').slice(0, -1).join('/');
  return `~/${directory ? `${directory}/**` : '**'}`;
};

const toAbsoluteRule = (targetPath: string) => {
  const normalized = normalizeWindowsPath(targetPath);
  const parsed = path.win32.parse(normalized);
  const directory = normalized.slice(0, normalized.lastIndexOf('\\')).replace(/\\/g, '/');
  return `//${directory}/**`;
};

export const buildPermissionRulesForPath = (targetPath: string, homeDir: string) => {
  const scope = toHomeRule(targetPath, homeDir) ?? toAbsoluteRule(targetPath);
  return [`Edit(${scope})`, `Write(${scope})`];
};
