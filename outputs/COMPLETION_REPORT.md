# Relayless completion report — 2026-08-06

## Result

Relayless now builds as a local-first Tox/XMPP Isolated Web App with an editable localhost workflow, encrypted multi-profile vault, unified conversations, real c-toxcore WebAssembly runtime, Direct Sockets adapter, secure XMPP WebSocket client, IWA bundling, offline signing, and release checksums.

## Architecture delivered

- React/Vite TypeScript UI with Russian and English, responsive Telegram-like navigation, profile rail, account/contact/chat screens, local notifications, command palette, and declarative plugins.
- Argon2id + AES-256-GCM encrypted IndexedDB vault. Tox savedata, XMPP credentials, contacts, history, drafts, settings, and plugin grants are encrypted together. Ephemeral profiles remain memory-only.
- c-toxcore v0.2.22 commit `da26052603369045dceb5dfc8c89919b222d0ce0`, libsodium 1.0.20, and Emscripten 4.0.3.
- Dedicated Tox Worker with real profile/savedata, ID, bootstrap, public TCP relays, friend add/accept/reject, contacts, text messages, receipts, presence, bounded UDP/TCP queues, automatic tox iteration, and deterministic shutdown.
- XMPP RFC 7395 WSS with SCRAM-SHA-256/SHA-1 verification, TLS-protected PLAIN fallback, binding, roster, presence, messages, receipts, chat states, XEP-0198 acknowledgement/resume, optional bounded MAM, reconnection, host-meta discovery, and XEP-0077 registration forms including CAPTCHA/data forms.
- No developer backend, proxy, analytics, telemetry, CDN runtime, remote fonts, or production signing key in CI.

## Verification actually run

- `npm.cmd run build:tox` — passed; produced 370,551-byte optimized `toxcore.wasm`.
- `npm.cmd run verify` — passed.
- TypeScript — passed.
- ESLint — passed with zero warnings.
- Vitest — 18 files, 47 tests passed.
- Production Vite bundle — passed.
- Privacy audit — passed across 22 dependencies and repository sources.
- Browser QA on editable localhost — passed; real 76-character Tox ID and savedata created.
- Browser QA on production preview — passed; real 76-character Tox ID created, no console errors.
- Unsigned IWA Web Bundle — built.
- Development Ed25519 signed Web Bundle — built and verified by `wbn-sign info`.
- Development Web Bundle ID: `isnbpykv6xkpxykyjfj2jxnn5qafsnzloznfenzzehobnwqkcgeqaaic`.

## Installation

The editable server is `http://127.0.0.1:4173/`.

For Tox networking, enable Chrome IWA developer mode, open `chrome://web-app-internals`, choose **Install IWA with Dev Mode Proxy**, and enter `http://127.0.0.1:4173`. A normal tab supports UI/XMPP/offline Tox profile work but does not expose Direct Sockets.

The included `relayless.swbn` is signed with a generated development key for local testing. Production releases must be rebuilt and signed with the maintainer's offline key.

## Honest remaining release gates

- Run the real external-client checklist in `INTEROPERABILITY.md` from an installed IWA: Relayless ↔ qTox/compatible Tox client and Relayless XMPP ↔ Gajim/Conversations. Automated localhost cannot access Direct Sockets.
- OMEMO and libotr are deliberately unavailable and fail closed until a pinned audited interoperable cryptographic engine is bundled. TLS-only XMPP is labeled honestly.
- Calls, XMPP group chat, and file transfer are not part of the completed core text-messaging path.
- Public unmanaged IWA installation eligibility depends on the exact Chrome channel/platform policy. Developer Mode Proxy and local signed-bundle installation are the validated local workflows.

## Exact next command

```powershell
npm.cmd run dev -- --port 4173
```

Then install `http://127.0.0.1:4173` as an IWA Dev Mode Proxy and execute `INTEROPERABILITY.md`.
