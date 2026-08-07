export interface ToxBootstrapNode {
  host: string;
  port: number;
  tcpPorts: number[];
  publicKey: string;
  enabled: boolean;
}

export type ToxState = 'offline' | 'starting' | 'connecting' | 'reconnecting' | 'online' | 'error';

export type ToxEvent =
  | { type: 'state'; state: ToxState; detail?: string }
  | { type: 'ready'; address: string; savedata: string; friends: ToxFriend[] }
  | { type: 'savedata'; savedata: string }
  | { type: 'friend-request'; publicKey: string; message: string }
  | { type: 'friend-connection'; friendNumber: number; publicKey: string; online: boolean }
  | { type: 'message'; friendNumber: number; publicKey: string; text: string; timestamp: number }
  | { type: 'receipt'; friendNumber: number; publicKey: string; messageId: number }
  | { type: 'transport'; transport: 'udp' | 'tcp'; state: 'created' | 'opening' | 'open' | 'closed' | 'error'; host?: string; port?: number };

export interface ToxFriend {
  friendNumber: number;
  publicKey: string;
}

export type ToxCommand =
  | { type: 'start'; savedata?: string; name: string; status: string; nodes: ToxBootstrapNode[]; gatewayUrls: string[] }
  | { type: 'stop' }
  | { type: 'snapshot' }
  | { type: 'set-profile'; name: string; status: string }
  | { type: 'add-friend'; address: string; message: string }
  | { type: 'accept-friend'; publicKey: string }
  | { type: 'remove-friend'; friendNumber: number }
  | { type: 'send-message'; friendNumber: number; text: string };

export interface ToxWorkerRequest {
  requestId: number;
  command: ToxCommand;
}

export type ToxWorkerResponse =
  | { kind: 'event'; event: ToxEvent }
  | { kind: 'reply'; requestId: number; ok: true; result?: unknown }
  | { kind: 'reply'; requestId: number; ok: false; error: string };
