export type PermissionAction = 'edit' | 'write';

export type PermissionRequest = {
  action: PermissionAction;
  targetPath: string;
  sensitive: boolean;
};

export const parsePermissionRequest = (content: string): PermissionRequest | null => {
  const normalized = content.trim();
  const match = normalized.match(
    /Claude requested permissions to (edit|write)(?: to)? ([A-Za-z]:\\[^\n]+?)(?:, but you haven't granted it yet\.| which is a sensitive file\.)/i,
  );

  if (!match) {
    return null;
  }

  return {
    action: match[1].toLowerCase() as PermissionAction,
    targetPath: match[2],
    sensitive: normalized.toLowerCase().includes('sensitive file'),
  };
};
