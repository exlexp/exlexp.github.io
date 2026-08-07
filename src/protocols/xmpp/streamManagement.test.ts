import { describe, expect, it } from 'vitest';
import { XmppStreamManager } from './streamManagement';

describe('XEP-0198 stream management', () => {
  it('keeps only unacknowledged stanzas for session resumption', () => {
    const manager = new XmppStreamManager();
    manager.enable('stream-id', true);
    manager.track('<message id="one"/>');
    manager.track('<message id="two"/>');
    manager.acknowledge(1);
    manager.suspend();
    expect(manager.resumeRequest()).toContain('previd="stream-id"');
    expect(manager.resume(1)).toEqual(['<message id="two"/>']);
  });

  it('rejects acknowledgements beyond the sent queue', () => {
    const manager = new XmppStreamManager();
    manager.enable('id', true);
    manager.track('<presence/>');
    expect(() => manager.acknowledge(2)).toThrow(/unsent/i);
  });
});
