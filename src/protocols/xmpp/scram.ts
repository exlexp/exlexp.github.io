import { base64ToBytes, bytesToBase64, concatBytes, randomBytes, toArrayBuffer, utf8 } from '../../security/encoding';

function saslName(value: string): string {
  return value.replaceAll('=', '=3D').replaceAll(',', '=2C');
}

export type ScramHash = 'SHA-1' | 'SHA-256';

async function hmac(key: Uint8Array, data: string, hash: ScramHash): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toArrayBuffer(utf8(data))));
}

async function digest(data: Uint8Array, hash: ScramHash): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(hash, toArrayBuffer(data)));
}

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length !== right.length) throw new Error('SCRAM proof length mismatch');
  return left.map((byte, index) => byte ^ (right[index] ?? 0));
}

export interface ScramSession {
  clientFirstBare: string;
  clientNonce: string;
  firstMessage: string;
  respond(challenge: string, password: string): Promise<{ response: string; serverSignature: string }>;
}

export function createScramSession(username: string, hash: ScramHash = 'SHA-256'): ScramSession {
  const clientNonce = bytesToBase64(randomBytes(18)).replaceAll('=', '');
  const clientFirstBare = `n=${saslName(username)},r=${clientNonce}`;
  return {
    clientFirstBare,
    clientNonce,
    firstMessage: `n,,${clientFirstBare}`,
    async respond(challenge: string, password: string) {
      const attributes = Object.fromEntries(
        challenge.split(',').map((part) => [part.slice(0, 1), part.slice(2)]),
      );
      const nonce = attributes.r;
      const salt = attributes.s;
      const iterations = Number(attributes.i);
      if (!nonce?.startsWith(clientNonce) || !salt || !Number.isInteger(iterations) || iterations < 4096) {
        throw new Error('XMPP server returned an invalid SCRAM challenge');
      }
      const passwordKey = await crypto.subtle.importKey('raw', toArrayBuffer(utf8(password)), 'PBKDF2', false, ['deriveBits']);
      const saltedPassword = new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: 'PBKDF2', hash, salt: toArrayBuffer(base64ToBytes(salt)), iterations },
          passwordKey,
          hash === 'SHA-256' ? 256 : 160,
        ),
      );
      const clientKey = await hmac(saltedPassword, 'Client Key', hash);
      const storedKey = await digest(clientKey, hash);
      const clientFinalWithoutProof = `c=biws,r=${nonce}`;
      const authMessage = `${clientFirstBare},${challenge},${clientFinalWithoutProof}`;
      const clientSignature = await hmac(storedKey, authMessage, hash);
      const proof = xor(clientKey, clientSignature);
      const serverKey = await hmac(saltedPassword, 'Server Key', hash);
      const serverSignature = bytesToBase64(await hmac(serverKey, authMessage, hash));
      saltedPassword.fill(0);
      clientKey.fill(0);
      storedKey.fill(0);
      serverKey.fill(0);
      const response = `${clientFinalWithoutProof},p=${bytesToBase64(proof)}`;
      proof.fill(0);
      return { response, serverSignature };
    },
  };
}

export function verifyServerFinal(serverFinal: string, expectedSignature: string): void {
  const verifier = serverFinal.split(',').find((part) => part.startsWith('v='))?.slice(2);
  if (!verifier) throw new Error('XMPP SCRAM server signature is missing');
  const received = base64ToBytes(verifier);
  const expected = base64ToBytes(expectedSignature);
  let difference = received.length ^ expected.length;
  for (let index = 0; index < Math.min(received.length, expected.length); index += 1) {
    difference |= (received[index] ?? 0) ^ (expected[index] ?? 0);
  }
  if (difference !== 0) throw new Error('XMPP SCRAM server signature verification failed');
}

export function encodeSasl(value: string): string {
  return bytesToBase64(utf8(value));
}

export function decodeSasl(value: string): string {
  return new TextDecoder().decode(concatBytes(base64ToBytes(value)));
}
