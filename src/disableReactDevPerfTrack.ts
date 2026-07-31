// react-dom's development build emits a performance.measure() entry with a large
// serialized props diff for every component render (Component/Scheduler
// performance tracks). The User Timing buffer is unbounded, so a long-lived dev
// tab accumulates gigabytes of Blink-side memory and crashes the renderer with
// an out-of-memory error once PartitionAlloc's 16 GiB pool is exhausted.
// react-dom gates the whole feature on `typeof console.timeStamp === 'function'`,
// captured once at module init — so this must run before react-dom initializes
// (imported first in main.tsx) and disables the feature entirely.
if (import.meta.env.DEV) {
  (console as { timeStamp?: unknown }).timeStamp = undefined;
}

export {};
