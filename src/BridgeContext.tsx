import { createContext, useContext } from 'react';
import { bridge } from './bridge';

export const BridgeContext = createContext(bridge);
export const useBridge = () => useContext(BridgeContext);
