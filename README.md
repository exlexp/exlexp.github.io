# Relayless

Local-first Russian/English IWA messenger foundation for XMPP and Tox, with no developer-operated backend or telemetry.

## Current status

The encrypted multi-profile vault, unified messenger UI, guided XMPP registration, Direct Sockets network adapter, real c-toxcore WebAssembly worker, XMPP WSS/SCRAM client, XEP-0198 resumption, opt-in MAM, tests, privacy audit, IWA manifest, unsigned bundling, and offline signing flow are implemented. Tox profiles create real IDs and persist upstream savedata; networking activates only where Direct Sockets exists. OMEMO and OTR remain fail-closed provider boundaries without bundled cryptographic engines, so TLS-only XMPP is never presented as end-to-end encrypted. See [LIMITATIONS.md](LIMITATIONS.md).

## Requirements

- Node.js 24+
- Current stable Chrome for the UI
- IWA developer mode / allowlisting as required by the installed Chrome release
- WSL2 Ubuntu plus Emscripten 4.0.3 when rebuilding c-toxcore

## Commands

```powershell
npm.cmd install
npm.cmd run dev
npm.cmd run build:tox
npm.cmd run verify
npm.cmd run bundle:iwa
$env:IWA_SIGNING_KEY='D:\offline\relayless.pem'
npm.cmd run sign:iwa
npm.cmd run checksums
```

Open the development UI at `http://127.0.0.1:4173`. Browser refreshes are handled by Vite while you edit files in `src/`.

Keep the signing key offline. Never add it, an exported vault, logs, accounts, or user-specific update data to Git.

## Install a development IWA

Start the dev server, enable `chrome://flags/#enable-isolated-web-app-dev-mode`, open `chrome://web-app-internals`, and choose **Install IWA with Dev Mode Proxy** for `http://127.0.0.1:4173`. This is the editable localhost path with Direct Sockets. For a release, install the locally signed `.swbn` through the applicable Chrome flow documented for the target channel and platform.

## Release

1. Run `npm.cmd ci` and `npm.cmd run verify` in a clean checkout.
2. Build the unsigned bundle with `npm.cmd run bundle:iwa`.
3. Rebuild independently and compare hashes.
4. On the offline signing machine, set `IWA_SIGNING_KEY` and run `npm.cmd run sign:iwa`.
5. Run `npm.cmd run checksums` and verify the bundle with `wbn-sign info dist/relayless.swbn`.
6. Upload only source, `.swbn`, `SHA256SUMS`, and public metadata to GitHub Releases.
7. Publish a static update manifest on GitHub Pages after the repository URL and Web Bundle ID are known.
