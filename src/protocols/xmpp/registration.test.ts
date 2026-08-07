import { describe, expect, it } from 'vitest';
import { buildRegistrationSubmission, parseRegistrationResponse, XmppRegistrationError } from './registration';

describe('XMPP in-band registration forms', () => {
  it('parses a legacy username/password form', () => {
    const form = parseRegistrationResponse('<iq type="result"><query xmlns="jabber:iq:register"><instructions>Create one</instructions><username/><password/><email/></query></iq>', 'example.test');
    expect(form.legacy).toBe(true);
    expect(form.fields.map((field) => field.key)).toEqual(['username', 'password', 'email']);
    expect(buildRegistrationSubmission(form, { username: 'alice', password: 's<&' })).toContain('<password>s&lt;&amp;</password>');
  });

  it('parses a CAPTCHA data form and preserves hidden challenge values', () => {
    const form = parseRegistrationResponse(`<iq type="result"><query xmlns="jabber:iq:register"><x xmlns="jabber:x:data" type="form">
      <field var="FORM_TYPE" type="hidden"><value>urn:xmpp:captcha</value></field>
      <field var="challenge" type="hidden"><value>abc</value></field>
      <field var="ocr" label="Code"><required/><media xmlns="urn:xmpp:media-element"><uri type="image/png">https://captcha.example.test/a.png</uri></media></field>
    </x></query></iq>`, 'example.test');
    expect(form.captcha).toBe(true);
    expect(form.fields.find((field) => field.key === 'ocr')?.media[0]?.uri).toBe('https://captcha.example.test/a.png');
    const submission = buildRegistrationSubmission(form, { ocr: '7231' });
    expect(submission).toContain('<field var="challenge"><value>abc</value></field>');
    expect(submission).toContain('<field var="ocr"><value>7231</value></field>');
  });

  it('accepts secure web registration redirects and rejects insecure ones', () => {
    const secure = parseRegistrationResponse('<iq type="result"><query xmlns="jabber:iq:register"><instructions>Use web</instructions><x xmlns="jabber:x:oob"><url>https://register.example.test/</url></x></query></iq>', 'example.test');
    const insecure = parseRegistrationResponse('<iq type="result"><query xmlns="jabber:iq:register"><x xmlns="jabber:x:oob"><url>http://register.example.test/</url></x></query></iq>', 'example.test');
    expect(secure.redirectUrl).toBe('https://register.example.test/');
    expect(insecure.redirectUrl).toBeUndefined();
  });

  it('maps server conflicts without exposing raw stanza data', () => {
    expect(() => parseRegistrationResponse('<iq type="error"><error><conflict xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>', 'example.test'))
      .toThrow(XmppRegistrationError);
  });
});
