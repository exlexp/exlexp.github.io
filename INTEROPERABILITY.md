# Manual interoperability checklist

Automated tests do not replace these checks. Record Chrome version, operating system, provider/client versions, time, and packet capture notes without message content.

## XMPP ↔ standard client

1. Install the signed IWA and unlock a fresh persistent vault.
2. Add an account on a provider exposing RFC 7395 WSS. Leave the local MAM option off for the default privacy test, then repeat once with it explicitly enabled.
3. Confirm SCRAM-SHA-256 is selected in local redacted diagnostics.
4. Verify roster and presence against current Gajim or Conversations.
5. Send plain text in both directions, including Unicode and XML metacharacters.
6. Verify XEP-0184 receipts where the peer supports them.
7. Interrupt the network, wait for bounded reconnect, and repeat.
8. Restart, unlock, verify encrypted local persistence, then export/import the vault.
9. Create a second profile, connect a different account, switch under each connection policy, and verify no sender, draft, history, receipt, or reconnect event appears in the other namespace.
10. Select required OMEMO or OTR and verify sending fails closed while the provider is unavailable; select optional/plaintext and verify the TLS-only warning is explicit.

## OMEMO / OTR

Blocked in this revision. Do not mark E2EE checks passed until the chosen library is pinned, built reproducibly, supplied with interoperability fixtures, and tested against current Conversations and Gajim. Trust changes, device additions/removals, multi-device copies, out-of-order messages, offline delivery, and downgrade attempts are mandatory cases.

## Tox ↔ qTox and second IWA

1. Install Relayless through IWA Dev Mode Proxy or a signed bundle; a normal tab has no Direct Sockets.
2. Create a Tox profile and copy its 76-character ID into qTox or another c-toxcore-compatible client.
3. Exchange and accept friend requests in both directions.
4. Send ASCII, Unicode, emoji, and XML metacharacters both ways; verify receipts and online/offline presence.
5. Test the default UDP route, then block UDP and verify a configured public TCP relay reconnects.
6. Test at least one IPv4 node and one numeric IPv6 node supported by the installed Chrome build.
7. Lock/unlock and restart the IWA; verify the same Tox ID and friend list are restored from encrypted savedata.
8. Create a second local profile and repeat IWA-to-IWA messaging. Verify savedata, events, contacts, and messages never cross profile boundaries.
9. Interrupt the network for 30 seconds, restore it, and verify automatic recovery without recreating the account.
10. Disconnect and remove the account; verify its Worker, timers, readers, writers, sockets, contacts, conversations, and savedata are removed.

This checklist is manual because Chrome exposes Direct Sockets only in the installed IWA environment. Record it as passed only after a real external client exchange.

## IWA update

Build versions N and N+1, sign both with the same offline key, publish immutable GitHub Release assets plus update manifest, install N, force an update check, verify N+1 and vault continuity, then rehearse dual-signature key rotation.
