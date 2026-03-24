import type { EasyAIFlowBridge } from './bridge';

export {};

declare global {
  interface Window {
    easyAIFlow?: EasyAIFlowBridge;
  }
}
