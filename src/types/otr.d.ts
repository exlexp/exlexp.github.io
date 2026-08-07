declare module 'otr' {
  export class DSA {
    constructor();
    static parsePrivate(value: string, libotr?: boolean): DSA;
    packPrivate(): string;
    fingerprint(): string;
  }

  export interface OtrConstants {
    MSGSTATE_PLAINTEXT: number;
    MSGSTATE_ENCRYPTED: number;
    MSGSTATE_FINISHED: number;
    STATUS_SEND_QUERY: number;
    STATUS_AKE_INIT: number;
    STATUS_AKE_SUCCESS: number;
    STATUS_END_OTR: number;
  }

  export interface OtrOptions {
    priv: DSA;
    instance_tag?: string;
    fragment_size?: number;
    send_interval?: number;
    debug?: boolean;
  }

  export class OTR {
    static CONST: OtrConstants;
    static makeInstanceTag(): string;
    constructor(options: OtrOptions);
    ALLOW_V2: boolean;
    ALLOW_V3: boolean;
    REQUIRE_ENCRYPTION: boolean;
    SEND_WHITESPACE_TAG: boolean;
    WHITESPACE_START_AKE: boolean;
    ERROR_START_AKE: boolean;
    msgstate: number;
    their_priv_pk?: DSA;
    on(event: 'io', listener: (message: string, meta?: unknown) => void): void;
    on(event: 'ui', listener: (message: string, encrypted: boolean, meta?: unknown) => void): void;
    on(event: 'error', listener: (message: string, severity: 'warn' | 'error') => void): void;
    on(event: 'status', listener: (status: number) => void): void;
    on(event: 'smp', listener: (type: 'question' | 'trust' | 'abort', data?: unknown, action?: string) => void): void;
    sendMsg(message: string, meta?: unknown): void;
    receiveMsg(message: string, meta?: unknown): void;
    sendQueryMsg(): void;
    endOtr(callback?: () => void): void;
    smpSecret(secret: string, question?: string): void;
    smpAbort(): void;
  }
}

declare module 'otr/test/spec/unit/data/keys.js' {
  import type { DSA } from 'otr';
  export const userA: DSA;
  export const userB: DSA;
}
