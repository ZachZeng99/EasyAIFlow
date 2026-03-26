type ExternalNavigationDecision = {
  currentUrl: string;
  targetUrl: string;
};

const parseUrl = (value: string, base?: string) => {
  try {
    return base ? new URL(value, base) : new URL(value);
  } catch {
    return null;
  }
};

export const shouldOpenExternally = ({ currentUrl, targetUrl }: ExternalNavigationDecision) => {
  const target = parseUrl(targetUrl, currentUrl);
  if (!target) {
    return false;
  }

  if (target.protocol === 'mailto:' || target.protocol === 'tel:') {
    return true;
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return false;
  }

  const current = parseUrl(currentUrl);
  if (!current) {
    return true;
  }

  if (current.protocol !== 'http:' && current.protocol !== 'https:') {
    return true;
  }

  return current.origin !== target.origin;
};
