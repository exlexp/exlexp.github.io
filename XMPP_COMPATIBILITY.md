# XMPP server compatibility

The client treats every provider as independently configured. It does not assume that all servers use the same WebSocket path, registration form, or authentication mechanisms.

## Implemented

- XEP-0156 WebSocket discovery through HTTPS `host-meta.json` and XRD, with CORS-safe requests and a manually editable fallback.
- RFC 7395 XMPP over secure WebSocket (`wss://`) only.
- SASL preference order: SCRAM-SHA-256, SCRAM-SHA-1, then PLAIN inside the verified TLS WebSocket.
- XEP-0077 unauthenticated in-band registration.
- XEP-0004 extended registration forms: text, password, JID, boolean, single/multiple choice, hidden and fixed fields.
- XEP-0158 CAPTCHA form fields, HTTPS-hosted images, and small embedded Bits of Binary images.
- XEP-0066 HTTPS registration redirects when the provider requires its website.
- Human-readable handling for username conflicts, policy rejection, expired sessions, rate limits, unavailable registration, and timeouts.

## Provider requirements

For automatic discovery from a web application, the provider needs to publish XEP-0156 metadata with appropriate CORS headers. If it does not, the user can enter the provider's `wss://` endpoint manually.

The server must advertise `http://jabber.org/features/iq-register` before the client offers in-app registration. CAPTCHA and other provider-specific questions need to be returned as XEP-0004 fields. Unknown fields are rendered conservatively as text fields rather than discarded.

## Deliberate limitations

- Plain `ws://`, insecure CAPTCHA media, and insecure registration redirects are rejected.
- BOSH is recognized as a possible provider deployment but is not used by this WebSocket-only runtime.
- SCRAM `-PLUS` channel-binding mechanisms cannot be implemented correctly with the browser WebSocket API because it does not expose TLS channel-binding material.
- External website registration cannot be completed inside the XMPP stream; the client opens only an HTTPS URL supplied by the server, after an explicit user click.
