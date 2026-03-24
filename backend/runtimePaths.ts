import os from 'node:os';
import path from 'node:path';

export type EasyAIFlowRuntime = 'desktop' | 'web';

type RuntimePathEnv = Partial<Record<'APPDATA' | 'XDG_DATA_HOME' | 'EASYAIFLOW_DATA_DIR', string>>;

type DefaultUserDataPathOptions = {
  platform?: NodeJS.Platform;
  env?: RuntimePathEnv;
  homePath?: string;
  appName?: string;
  pathExists?: (candidate: string) => boolean;
};

type RuntimePaths = {
  mode: EasyAIFlowRuntime;
  userDataPath: string;
  homePath: string;
};

const defaultAppName = 'EasyAIFlow';

export const resolveDefaultDesktopUserDataPath = ({
  platform = process.platform,
  env = process.env,
  homePath = os.homedir(),
  appName = defaultAppName,
}: DefaultUserDataPathOptions = {}) => {
  if (platform === 'win32') {
    const appDataRoot = env.APPDATA?.trim() || path.join(homePath, 'AppData', 'Roaming');
    return path.join(appDataRoot, appName);
  }

  if (platform === 'darwin') {
    return path.join(homePath, 'Library', 'Application Support', appName);
  }

  const xdgRoot = env.XDG_DATA_HOME?.trim() || path.join(homePath, '.config');
  return path.join(xdgRoot, appName);
};

const resolveLegacyWebUserDataPath = ({ homePath = os.homedir() }: DefaultUserDataPathOptions = {}) =>
  path.join(homePath, '.easyaiflow-web');

export const resolveDefaultWebUserDataPath = (options: DefaultUserDataPathOptions = {}) => {
  const override = options.env?.EASYAIFLOW_DATA_DIR?.trim();
  if (override) {
    return override;
  }

  const sharedDesktopPath = resolveDefaultDesktopUserDataPath(options);
  if (options.pathExists?.(sharedDesktopPath)) {
    return sharedDesktopPath;
  }

  return resolveLegacyWebUserDataPath(options);
};

let runtimePaths: RuntimePaths = {
  mode: 'desktop',
  userDataPath: resolveDefaultDesktopUserDataPath(),
  homePath: os.homedir(),
};

export const configureRuntimePaths = (next: Partial<RuntimePaths>) => {
  runtimePaths = {
    ...runtimePaths,
    ...next,
  };
};

export const getRuntimePaths = () => runtimePaths;
