# Privacy

Relayless has no developer backend, analytics, telemetry, advertising, account service, push service, cookies created by application code, remote fonts, or CDN runtime dependencies.

Persistent profiles are serialized into one versioned envelope, derived with Argon2id and encrypted with AES-256-GCM before IndexedDB writes. Tox savedata, XMPP passwords, contacts, drafts, messages, settings, and plugin grants live inside that envelope. Ephemeral profiles are memory-only. Locking clears the decrypted in-memory model and stops protocol clients; wiping deletes the IndexedDB database.

The app connects only to destinations selected by the user or present in the reviewed bundled Tox node list. XMPP providers can see connection metadata and may ignore no-store hints. Public Tox bootstrap/relay nodes and peers can see network metadata. Message previews are disabled by default. No closed-app delivery is claimed because there is no push server.

Run `npm.cmd run privacy:audit` before every release.
