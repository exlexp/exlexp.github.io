const SENSITIVE_KEYS = /password|secret|token|savedata|private|credential|message|body/i;
const JID = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+/g;
const TOX_ID = /\b[A-Fa-f0-9]{76}\b/g;

export function redactText(value: string): string {
  return value.replace(JID, '[jid]').replace(TOX_ID, '[tox-id]');
}

export function redactError(error: unknown): string {
  if (error instanceof Error) return redactText(error.message).slice(0, 300);
  return 'Unexpected local error';
}

export function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEYS.test(key) ? '[redacted]' : redactObject(item)]),
    );
  }
  return typeof value === 'string' ? redactText(value) : value;
}
