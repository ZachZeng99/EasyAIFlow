import os from 'node:os';
import path from 'node:path';

export type EasyAIFlowRuntime = 'desktop' | 'web';

type RuntimePaths = {
  mode: EasyAIFlowRuntime;
  userDataPath: string;
  homePath: string;
};

let runtimePaths: RuntimePaths = {
  mode: 'desktop',
  userDataPath: path.join(os.homedir(), '.easyaiflow'),
  homePath: os.homedir(),
};

export const configureRuntimePaths = (next: Partial<RuntimePaths>) => {
  runtimePaths = {
    ...runtimePaths,
    ...next,
  };
};

export const getRuntimePaths = () => runtimePaths;
