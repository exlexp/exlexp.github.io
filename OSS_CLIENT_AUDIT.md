# OSS client audit

Reviewed 2026-08-06 against the browser/IWA architecture, current upstream status, licensing, and security boundaries.

## Tox

- **qTox** is a GPL desktop client with chat, voice/video, and file-transfer UX worth studying. Its official repository was archived on 2025-02-16 and is read-only, so it is a feature reference rather than an implementation base.
- **c-toxcore v0.2.22** is the current protocol engine release reviewed here. Relayless pins its release commit `da26052603369045dceb5dfc8c89919b222d0ce0`. The release includes hardening and testing work, but upstream explicitly says the experimental cryptographic network library has not received an independent specialist audit.
- Its callback/event-loop model, savedata, friends, messages, groups, transfers, and toxav are the feature source. Relayless now injects the upstream `Network_Funcs` interface, runs toxcore in a Worker, and maps it to bounded Direct Sockets queues. qTox remains a behavior/interoperability reference; no qTox source was copied.

## XMPP

- **Converse.js 13.0.0** is a mature MPL-2.0 browser client with a broad XEP surface, including MAM, stream management, and OMEMO. It is also a complete UI/state engine, so importing it wholesale would duplicate profile state and make isolation harder to prove.
- **@xmpp/client / xmpp.js 0.14.0** is an ISC headless stack and remains the best candidate for replacing the custom transport behind the existing account interface. It must first pass the project's SCRAM, reconnect, stanza-bound, stream-resume, and cross-profile fixtures.
- Relayless keeps its small WSS transport and has added tested SCRAM-SHA-256/SHA-1, receipts, chat states, bounded reconnect, XEP-0198 queue/resume logic, explicit MAM opt-in, and server-driven registration forms. It does not claim OMEMO, calls, file transfer, or group chat.

## Product decision

Do not copy Telegram, qTox, or Converse assets and source wholesale. Reuse familiar interaction patterns and documented protocol behavior, with independent visuals and narrow adapters. Every imported dependency needs an exact revision, compatible license, SBOM entry, negative tests, and a reproducible artifact before it can become a production runtime.

Primary references:

- https://github.com/TokTok/c-toxcore
- https://github.com/TokTok/c-toxcore/releases/tag/v0.2.22
- https://github.com/qTox/qTox
- https://github.com/conversejs/converse.js/tree/v13.0.0
- https://github.com/xmppjs/xmpp.js/tree/v0.14.0
