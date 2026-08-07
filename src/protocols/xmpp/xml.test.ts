import { describe, expect, it } from 'vitest';
import { escapeXml, parseXmppElement, textOf } from './xml';

describe('safe XMPP XML handling', () => {
  it('escapes outbound message content', () => {
    expect(escapeXml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&apos;');
  });

  it('parses a normal message stanza', () => {
    const element = parseXmppElement('<message from="a@example.test"><body>Hello</body></message>');
    expect(textOf(element, 'body')).toBe('Hello');
  });

  it('rejects declarations and malformed XML', () => {
    expect(() => parseXmppElement('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(/unsafe/i);
    expect(() => parseXmppElement('<message>')).toThrow(/malformed/i);
  });
});
