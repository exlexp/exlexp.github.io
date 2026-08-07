import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
if (!globalThis.structuredClone) Object.defineProperty(globalThis, 'structuredClone', { value: (value: unknown) => JSON.parse(JSON.stringify(value)) });
