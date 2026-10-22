# OnlineGaming

A Rwanda-first multiplayer gaming platform foundation for web/mobile competitive play and a future regulated player-to-player wagering capability.

> **Launch gate:** public wagering, deposits, withdrawals, stake escrow and payouts stay disabled until the competent regulator confirms the exact product and P2P model are authorized, the operator holds a valid applicable licence, each payment provider approves the licensed gambling use case, and independent security/compliance sign-off is complete.

## Current repository status

The repository was empty at bootstrap. The first implementation slice adds a strict TypeScript workspace, Fastify health/readiness API, integer-only money primitives, signed real-money launch-attestation verification, a deterministic Tic-Tac-Toe engine with tests, and PostgreSQL tables for users, matches/events, player safety, wagers, payment operations, audit and double-entry ledger entries. It does not claim the whole platform is already production-ready.

## Product direction

- Multiplayer lobby, matchmaking, challenges, friend/social controls, tournaments, ratings, history, reports and disputes.
- Server-authoritative real-time games with validated commands, sequence/version checks, replayable events, reconnects and anti-cheat signals.
- Identity, age/eligibility, MFA, session/device management, responsible-play limits, cooling-off and self-exclusion.
- Future regulated financial operations with append-only double-entry accounting, idempotent payment intents, signed provider webhooks, reconciliation, risk holds and audited settlement.
- Admin console with least-privilege access, review queues, payment reconciliation, fraud cases and immutable audit records.

## Architecture

Start with a modular monolith to keep game, safety, wager, payment and ledger invariants inside a single transaction boundary. Use TypeScript/pnpm, Fastify, PostgreSQL as the durable source of truth, Redis only for ephemeral presence/throttling, Socket.IO for authorized real-time rooms, and durable workers/outbox patterns for notifications and reconciliation. Planned clients: Next.js web and Expo/React Native mobile.

## Financial invariants

1. Money uses integer minor units plus explicit currency; never floating point.
2. Every ledger transaction balances debits/credits by currency and is append-only; corrections use compensating entries.
3. Provider callbacks are untrusted until signature, merchant, reference, amount, currency, state and idempotency checks pass.
4. Client code never determines balances, payment success or match results.
5. Wager acceptance requires eligibility checks, safety/risk checks, explicit consent, sufficient funds, a signed market-release gate and authoritative results.
6. Holds and settlement must be atomic, idempotent, auditable and replay-safe.
7. Unknown payment outcomes are reconciled rather than assumed successful.
8. Admins cannot edit balances directly; financial corrections require permission, dual control and audit.
9. Kill switches can stop new wagers, deposits, withdrawals or all money movement without deleting records.
10. CI uses synthetic accounts/test providers only. Test callbacks are not real payments.

## Rwanda regulatory and privacy gate

RDB's published 2025 directive said the then-existing framework remained in force while a new legal framework was under review, and referenced Law No. 58/2011, Ministerial Order No. 01/013/2013, and Ministerial Order No. 001/MINICOM/2023. It listed expressions of interest for online sports betting and online casino with a deadline of **30 September 2025**, now past. That notice does not establish that P2P wagering on games of skill is covered by any specific licence. Obtain current written guidance from Rwanda's competent regulator / National Lottery & Gambling Commission and Rwanda-qualified counsel on the exact games, stakes, fees, player eligibility and territories; obtain explicit approval from each payment provider for the licensed use case.

Personal-data processing must be reviewed against Rwanda's Personal Data Protection and Privacy Law, including purpose limitation, minimization, retention, rights requests, access control, incident response and lawful international transfers/storage.

Official references:
- RDB directive: https://rdb.rw/wp-content/uploads/2025/08/Directives-to-Gambling-Operators-and-Interested-Parties.pdf
- Rwanda Data Protection & Privacy Office: https://dpo.gov.rw/dpp-law/general-provisions
- Irembo online-gaming annual-fee prerequisites: https://support.irembo.gov.rw/en/support/solutions/articles/47001262022-how-to-make-payment-for-online-gaming-annual-fees

## Delivery phases

0. **Foundation:** CI, lockfile, threat model, migration runner, secret/dependency scans, local containers and repository protection.
1. **Identity:** account recovery, MFA/session rotation, verified profiles, object-level authorization and audit.
2. **Multiplayer without money:** persistent matchmaking/challenges, authoritative rooms, reconnect/replay, ratings, reports/disputes and anti-cheat.
3. **Player safety:** eligibility, limits, self-exclusion, cooling-off, reminders, market restrictions and collusion reviews.
4. **Restricted ledger and sandbox providers:** ledger posting service, payment intents, signed webhook inbox, reconciliation and failure injection.
5. **Licensed pilot:** written regulator/provider approval, allowlist, low limits, daily reconciliation, manual monitoring and rollback.
6. **Production:** independent penetration test, capacity tests, recovery drills, financial reconciliation evidence and continuous compliance review.

Every phase needs observable behaviour, automated tests and operational evidence. No fake success paths, hard-coded balances, silent exception swallowing, insecure debug routes or production secrets in source control.
