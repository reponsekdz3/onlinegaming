# Implementation roadmap and definition of done

## Step 0 — Foundation (started)
- [x] Establish repository engineering contract.
- [x] Add TypeScript workspace, health/readiness API, integer-money primitives, signed wagering release gate, deterministic Tic-Tac-Toe rules and tests.
- [x] Define core PostgreSQL entities, append-only ledger tables and deferred balance triggers.
- [ ] Generate and commit a reproducible pnpm lockfile; run a clean install/build/test/typecheck in CI.
- [ ] Add migration runner, local containers, dependency/secret scans and branch protection.
- [ ] Validate migration against real PostgreSQL and add rollback tests.

## Step 1 — Persistence and identity
- [ ] DB lifecycle, migrations and transaction helpers.
- [ ] Registration, password hashing, verified email/phone, recovery, refresh rotation, MFA and session revocation.
- [ ] Permission registry, object-level policies, identity-provider boundary and audit trail.
- [ ] Tests for cross-account access, token reuse, brute force, enumeration, limits and recovery.

## Step 2 — Matchmaking and multiplayer
- [ ] Persist matches, invitations, acceptance, expiry, timeout and cancellation.
- [ ] Socket authentication and room authorization.
- [ ] Atomic match commands with versioning, row locks, idempotency and replay log.
- [ ] Reconnect, ratings/history, reports, moderation, disputes and admin audit.
- [ ] Load/chaos tests for duplicate commands, stale versions, disconnects, restarts and colluding clients.

## Step 3 — Web and mobile clients
- [ ] Accessible responsive Next.js lobby/game/profile/history/challenge/notifications/safety app.
- [ ] Expo mobile client using the same server-owned game protocol and secure session storage.
- [ ] Shared API types/runtime validation; no UI-only authorization.
- [ ] Browser/mobile end-to-end tests across signup, play, reconnect, reporting and restrictions.
- [ ] Loading/error/empty states backed by API data; no fake balance/payment success.

## Step 4 — Integrity and safeguards
- [ ] Versioned game-engine registry, rate limits, replay verification and anti-cheat review.
- [ ] Eligibility/location policies, self-exclusion, cooling-off, limits and reminders.
- [ ] Abuse review, evidence preservation, appeals and reviewer audit.

## Step 5 — Ledger and providers (sandbox first)
- [ ] Transactional ledger posting service serializing conflicting balance operations.
- [ ] Payment state machine, verified webhook inbox, provider signature contracts and idempotency.
- [ ] Deposit/withdrawal reconciliation, reserves, refunds, disputes and accounting export.
- [ ] Property-based invariants and failure injection; no public-money capability without signed release evidence.

## Step 6 — Licensed pilot
- [ ] Written regulator classification/licence conditions for exact games and P2P model.
- [ ] Written payment-provider permission and production merchant onboarding.
- [ ] Independent game-integrity, penetration and ledger review.
- [ ] Signed evidence, allowlisted players, low limits, manual monitoring and rollback.
- [ ] Daily provider-to-ledger reconciliation and incident/complaint runbooks.

## Step 7 — Scale and operations
- [ ] Capacity/load testing, observability, on-call alerts, backup restore drills and disaster recovery.
- [ ] Mobile release controls, crash monitoring, staged rollout.
- [ ] Ongoing reconciliation, risk tuning, compliance reporting and access review.

A checkbox is complete only when code exists, automated tests exercise it, and operational evidence is reviewed.
