import { canonicalJson, MUTATING_RPC_METHODS, stripRpcMetadata } from './rpcOperations.js';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStorage = (): StorageLike | undefined => {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
};

const requestDigest = async (text: string) => {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // Browsers on a LAN HTTP origin lack SubtleCrypto. This is only a local
  // lookup key; the service independently checks a cryptographic fingerprint.
  let left = 2166136261;
  let right = 5381;
  for (let index = 0; index < text.length; index += 1) {
    left = Math.imul(left ^ text.charCodeAt(index), 16777619);
    right = Math.imul(right, 33) ^ text.charCodeAt(index);
  }
  return `${text.length}-${(left >>> 0).toString(16)}-${(right >>> 0).toString(16)}`;
};

const newOperationId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

// Keep only the request ID and a digest locally, never the prompt or attachments.
// Unknown outcomes survive a renderer reload and reuse the same server ledger entry.
export const withOperationIdentity = <T extends object>(
  bridge: T,
  storage: StorageLike | undefined = defaultStorage(),
  deviceId?: string,
): T => {
  const pending = new Map<string, string>();
  return new Proxy(bridge, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !MUTATING_RPC_METHODS.has(property) || typeof original !== 'function') return original;
      return async (payload?: unknown) => {
        const normalized = stripRpcMetadata(property, payload);
        const key = `eaf.operation.${await requestDigest(canonicalJson({ ...(deviceId ? { deviceId } : {}), method: property, payload: normalized }))}`;
        let operationId = pending.get(key);
        try { operationId ??= storage?.getItem(key) ?? undefined; } catch { /* Storage may be disabled. */ }
        operationId ??= newOperationId();
        pending.set(key, operationId);
        try { storage?.setItem(key, operationId); } catch { /* The in-memory identity still protects transport retries. */ }
        const clear = () => {
          pending.delete(key);
          try { storage?.removeItem(key); } catch { /* Optional browser storage. */ }
        };
        const request = { ...(normalized && typeof normalized === 'object' ? normalized : {}), operationId };
        for (let attempt = 0; ; attempt += 1) {
          try {
            const result = await original.call(target, request);
            clear();
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const retryable = message.includes('EAF_TRANSPORT_RETRYABLE');
            if (retryable && attempt < 1) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              continue;
            }
            if (!retryable && !['EAF_OPERATION_UNCERTAIN', 'EAF_OPERATION_CONFLICT', 'EAF_AUTH_REQUIRED', 'EAF_DEVICE_UNAVAILABLE'].some((code) => message.includes(code))) clear();
            throw error;
          }
        }
      };
    },
  });
};
