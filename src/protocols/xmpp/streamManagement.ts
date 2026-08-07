const COUNTER_MODULO = 2 ** 32;
const MAX_UNACKED_STANZAS = 1024;

export class XmppStreamManager {
  private sessionId = '';
  private canResume = false;
  private active = false;
  private sent = 0;
  private received = 0;
  private lastAcknowledged = 0;
  private unacknowledged: string[] = [];

  get enabled(): boolean { return this.active; }
  get resumable(): boolean { return Boolean(this.sessionId && this.canResume); }
  get inboundCount(): number { return this.received >>> 0; }
  get pendingCount(): number { return this.unacknowledged.length; }

  enable(id: string, resume: boolean): void {
    this.sessionId = id;
    this.canResume = resume;
    this.active = true;
    this.sent = 0;
    this.received = 0;
    this.lastAcknowledged = 0;
    this.unacknowledged = [];
  }

  track(xml: string): void {
    if (!this.active) return;
    if (this.unacknowledged.length >= MAX_UNACKED_STANZAS) throw new Error('XMPP acknowledgement queue limit reached');
    this.sent = (this.sent + 1) % COUNTER_MODULO;
    this.unacknowledged.push(xml);
  }

  countInbound(): void {
    if (this.active) this.received = (this.received + 1) % COUNTER_MODULO;
  }

  acknowledge(serverCount: number): void {
    if (!Number.isInteger(serverCount) || serverCount < 0 || serverCount >= COUNTER_MODULO) throw new Error('Invalid XMPP stream acknowledgement');
    const acknowledged = (serverCount - this.lastAcknowledged + COUNTER_MODULO) % COUNTER_MODULO;
    if (acknowledged > this.unacknowledged.length) throw new Error('XMPP server acknowledged unsent stanzas');
    this.unacknowledged.splice(0, acknowledged);
    this.lastAcknowledged = serverCount;
  }

  suspend(): void { this.active = false; }

  resumeRequest(): string {
    if (!this.resumable) throw new Error('XMPP stream is not resumable');
    return `<resume xmlns="urn:xmpp:sm:3" h="${this.inboundCount}" previd="${escapeAttribute(this.sessionId)}"/>`;
  }

  resume(serverCount: number): string[] {
    this.acknowledge(serverCount);
    this.active = true;
    return [...this.unacknowledged];
  }

  recoverForFreshStream(serverCount?: number): string[] {
    if (serverCount !== undefined) this.acknowledge(serverCount);
    const pending = [...this.unacknowledged];
    this.reset();
    return pending;
  }

  reset(): void {
    this.sessionId = '';
    this.canResume = false;
    this.active = false;
    this.sent = 0;
    this.received = 0;
    this.lastAcknowledged = 0;
    this.unacknowledged = [];
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
