# Relayless architecture

Relayless is an Isolated Web App (IWA) intended to connect directly from the user's Chrome process to third-party Tox peers/nodes and a user-selected XMPP provider. There is no application backend, account service, telemetry pipeline, or developer-controlled relay.

## Runtime boundaries

- `src/security`: Argon2id password derivation, AES-256-GCM envelopes, IndexedDB persistence, redaction, encrypted single-profile import/export. Persistent records contain one versioned encrypted envelope. Ephemeral profiles are filtered before every write.
- `src/models`: versioned schema migration and isolated profile namespaces. Each profile owns accounts, contacts, conversations, messages, drafts, identities, settings, and UI state. Profile deletion removes only that namespace.
- `src/encryption`: protocol-neutral provider contracts, explicit plaintext policy, device trust/fingerprint state, and a dedicated OTR worker lifecycle. Unavailable providers fail closed instead of silently downgrading.
- `src/plugins`: declarative API v1. Local manifests may add bounded commands after explicit permission grants. They cannot execute arbitrary JavaScript, access credentials, open sockets, or read message bodies.
- `src/network`: the only raw TCP/UDP constructors and the in-memory `NetworkPolicy` activity ledger. Production code refuses Direct Sockets when the IWA API is absent.
- `src/protocols/xmpp`: RFC 7395 secure WebSocket transport, SCRAM-SHA-256/SHA-1 with server-signature verification, TLS-protected PLAIN fallback, binding, roster, presence, one-to-one messages, receipts, chat states, XEP-0198 acknowledgement/resumption, opt-in bounded MAM, reconnect, endpoint discovery, and XEP-0077 data-form/CAPTCHA registration.
- `src/protocols/tox`: a dedicated worker loads the pinned c-toxcore WASM module. A small C bridge injects upstream `Network_Funcs`; TypeScript maps numeric handles to bounded UDP/TCP queues and Direct Sockets read/write loops. The worker owns iteration, timers, sockets, savedata, friend requests, contacts, messages, receipts, and deterministic shutdown.
- `src/ui`: React UI with a permanent profile rail, aggregate inbox, keyboard navigation, command palette, sender selector, local notifications, and no remote fonts, HTML injection, analytics, or runtime CDN code.

## Decisions

1. WebSocket XMPP is the mandatory secure path. Direct TCP XMPP is excluded because Direct Sockets supplies raw TCP, not TLS, and inventing a TLS stack would be unsafe.
2. Password-derived keys are not stored. Argon2id derives 256 bits; WebCrypto AES-GCM uses a fresh 96-bit nonce, schema-associated data, and a 128-bit tag for each rewrite.
3. Message bodies are rendered as React text nodes. XML input is size-bounded, rejects DTD/entity declarations, and is parsed with `DOMParser`.
4. Connection history is memory-only. No connectivity probes are made; state comes from real protocol attempts.
5. The app is GPL-3.0-or-later because c-toxcore is GPL-3.0. React, idb, hash-wasm, lucide-react, and simple-icons use compatible permissive or data licenses described in `THIRD_PARTY_NOTICES.md`. c-toxcore is pinned to v0.2.22 commit `da26052603369045dceb5dfc8c89919b222d0ce0`; Emscripten is pinned to 4.0.3 and libsodium to 1.0.20 with a checked SHA-256.
6. Switching profiles is transactional: compose state is saved, the selected profile becomes the only active namespace, and the previous profile is backgrounded, slept, or disconnected according to its policy. Sending requires a source account belonging to the current profile.
7. Schema v2 migrates the original single-profile vault to one local profile without discarding data. Duplicating a profile copies settings only, never accounts, credentials, keys, contacts, or history.
8. Extensions are data, not trusted code. Requested capabilities are separately granted, persisted inside the encrypted vault, and checked before commands become available.

## Platform facts verified 2026-08-06

Chrome's IWA Direct Sockets API exposes `TCPSocket`, `TCPServerSocket`, and `UDPSocket`, and requires `direct-sockets` plus `cross-origin-isolated` permissions. IWA assets are packed as Web Bundles and signed locally; the manifest lives at `/.well-known/manifest.webmanifest`. References:

- https://developer.chrome.com/docs/iwa/direct-sockets
- https://developer.chrome.com/docs/iwa/introduction
- https://developer.chrome.com/docs/iwa/key-rotation
- https://datatracker.ietf.org/doc/html/rfc7395
- https://github.com/TokTok/c-toxcore/tree/da26052603369045dceb5dfc8c89919b222d0ce0
