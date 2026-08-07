# Threat model

## Assets

Vault password, Tox savedata/private keys, XMPP credentials, contacts, drafts, local message history, identity links, and local configuration.

## Adversaries and controls

- **Malicious XMPP provider:** can observe JIDs, IP metadata, traffic timing, plaintext TLS-only message bodies, and may store messages despite XEP-0334 hints. WSS authenticates transport; SCRAM avoids sending the password when supported. Unavailable OMEMO/OTR providers fail closed and the UI never presents TLS-only transport as E2EE.
- **Cross-profile confusion:** profile-owned records use separate namespaces and outbound sends require an account from the active profile. Switching saves draft/UI state before applying background, sleep, or disconnect policy. Duplicating settings never copies identity secrets.
- **Malicious Tox peer, bootstrap node, or relay:** can send malformed/oversized traffic and observe metadata appropriate to its role. Raw packet queues must remain bounded and input validated before a production Tox engine is enabled.
- **Compromised GitHub or release artifact:** releases are reproducibly built, checksummed, and locally signed with an offline key. Users should verify the Signed Web Bundle and checksum. The signing key is never stored in CI.
- **Stolen signing key:** stop publication, preserve evidence, rotate through Chrome's IWA allowlist process, and dual-sign old and new artifacts where the old key remains available.
- **Malicious message content / XSS:** React text rendering, no `dangerouslySetInnerHTML`, strict CSP, Trusted Types requirement, local-only scripts, DTD rejection, and message-size bounds.
- **Supply-chain compromise:** exact dependency versions and lockfile, dependency audit, small dependency set, no runtime CDN. Review lockfile changes before release.
- **Local device compromise:** an attacker controlling the unlocked browser can read data. The vault protects data at rest, not a compromised live process. Auto-lock limits exposure.
- **Vault guessing:** Argon2id with 64 MiB and three iterations, minimum password length, authenticated encryption, and no password recovery. Production UI should add an increasing local delay after repeated failures before wider distribution.
- **Metadata leakage:** direct peers/providers necessarily learn network metadata. The developer receives nothing. Connection display is local and non-persistent.
- **Rollback:** IWA versions are monotonic and signed. Release procedures must not republish a lower version in the default update channel.
- **Diagnostics:** disabled by default, redacted, memory-only, bounded, and removable. Secret fields are never sent to `console`.

## Residual risk

XMPP is not end-to-end encrypted in this revision because the OMEMO/OTR engines remain unavailable. Tox production networking is disabled until the c-toxcore Direct Sockets adapter is complete and independently tested. Browser/OS compromise defeats the unlocked vault. Public Tox nodes and selected XMPP providers are third parties, not privacy-neutral infrastructure.
