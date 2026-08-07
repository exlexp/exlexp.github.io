# Building Relayless

## Application

Requirements: Node.js 24+, npm, and PowerShell.

```powershell
npm.cmd ci
npm.cmd run verify
npm.cmd run bundle:iwa
npm.cmd run checksums
```

`verify` runs TypeScript, ESLint, unit/integration tests, the production Vite build, and the privacy audit. `bundle:iwa` produces `dist/relayless.wbn`.

## Rebuild c-toxcore WebAssembly

The checked-in runtime is generated from c-toxcore commit `da26052603369045dceb5dfc8c89919b222d0ce0`, libsodium 1.0.20 SHA-256 `ebb65ef6ca439333c2bb41a0c1990587288da07f6c7fd07cb3a18cc18d30ce19`, and Emscripten 4.0.3. On Windows, enable WSL2 and install an Ubuntu distribution, then install the prerequisites once:

```bash
sudo apt-get update
sudo apt-get install -y git cmake ninja-build build-essential autoconf automake libtool pkg-config python3 curl xz-utils tar perl ca-certificates
sudo git clone --depth 1 --branch 4.0.3 https://github.com/emscripten-core/emsdk.git /opt/emsdk
sudo chown -R "$USER" /opt/emsdk
cd /opt/emsdk
./emsdk install 4.0.3
./emsdk activate 4.0.3
```

Then, from Windows PowerShell:

```powershell
npm.cmd run build:tox
npm.cmd run verify
```

The build script checks out the exact toxcore commit, verifies libsodium, and writes `public/tox/toxcore.mjs` plus `public/tox/toxcore.wasm`.

## Offline signing

```powershell
openssl genpkey -algorithm ED25519 -out D:\offline\relayless.pem
$env:IWA_SIGNING_KEY='D:\offline\relayless.pem'
npm.cmd run sign:iwa
npm.cmd run verify:signed
npm.cmd run checksums
```

Never store the production private key in the repository or CI.
