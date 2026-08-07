# XMPP dependency audit

Reviewed 2026-08-06 for browser/IWA use, multi-profile isolation, OMEMO readiness, licensing, and supply-chain cost.

## Candidates

### Converse.js 13.0.0

- Mature browser-first XMPP client under MPL-2.0 with XEP-0198, MAM, and OMEMO support.
- It is a complete client/state engine rather than a small transport module. Replacing the existing React UI and profile-owned state with Converse would expand the trusted code surface and make namespace isolation harder to prove.
- OMEMO delegates cryptography to `libomemo.js`; adopting Converse does not remove the need to audit that cryptographic boundary.

### @xmpp/client 0.14.0

- Headless ISC-licensed stack with WebSocket, reconnect, and stream-management packages; it is the closest architectural match.
- The published browser mapping excludes TCP/TLS/STARTTLS and SCRAM-SHA-1. WSS-only transport is appropriate here, but compatibility must be measured against the project's required providers.
- It does not supply a reviewed OMEMO implementation or the application's trust UX.

### libomemo.js

- GPL-3.0 crypto wrapper supporting legacy and OMEMO 2 namespaces; license is compatible with this GPL-3.0-or-later project.
- Its own README says it has not received a formal third-party audit. It is crypto-only: stanza processing, PEP publication, and SCE integration remain application responsibilities.
- Building requires Emscripten/native Curve25519 dependencies, increasing reproducibility and review work.

## Decision

Do not replace the working RFC 7395/SCRAM-SHA-256 transport or claim OMEMO in this revision. Keep the provider boundary fail-closed, capture interoperability fixtures from current Gajim and Conversations, then evaluate `@xmpp/client` as a headless transport replacement behind the existing account interface. Converse remains a useful reference implementation; `libomemo.js` must not be enabled until its build is pinned and its crypto/runtime boundary receives an independent review.

## Acceptance gate for a future replacement

1. Two simultaneous profiles cannot share stanza handlers, reconnect timers, roster state, or credentials.
2. SCRAM server signatures, XML limits, reconnect bounds, receipts, and no-store hints retain automated negative tests.
3. XEP-0198 resume never duplicates an outbound message or attributes it to the wrong profile.
4. OMEMO passes multi-device, offline, trust-change, out-of-order, downgrade, and current-client interoperability tests.
5. Exact source revisions, licenses, reproducible artifacts, SBOM, and third-party notices ship with the IWA.

## Primary references

- https://github.com/conversejs/converse.js
- https://github.com/xmppjs/xmpp.js
- https://github.com/conversejs/libomemo.js
- https://xmpp.org/extensions/xep-0384.html
