# Installing Relayless

## Editable localhost with Direct Sockets

1. Run `npm.cmd run dev -- --port 4173`.
2. In Chrome, enable `chrome://flags/#enable-isolated-web-app-dev-mode` and restart Chrome.
3. Open `chrome://web-app-internals`.
4. Choose **Install IWA with Dev Mode Proxy** and enter `http://127.0.0.1:4173`.
5. Launch Relayless from Chrome's installed apps. The same source remains editable and Vite refreshes it.

A normal `http://127.0.0.1:4173` tab is useful for UI, vault, XMPP, and offline Tox profile tests, but Chrome exposes raw UDP/TCP Direct Sockets only to the installed IWA context.

## Signed bundle

Build and sign as described in `BUILDING.md`, then use the installation mechanism supported by the exact Chrome release and device policy. Verify `dist/relayless.swbn` with `npm.cmd run verify:signed` and compare `dist/SHA256SUMS` before installation.
