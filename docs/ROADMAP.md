# Implementation roadmap and definition of done

## Step 0 — Foundation
- [x] Establish repository engineering contract.
- [x] Add TypeScript workspace, HTTP health/readiness API, integer-money primitives, signed release gate, deterministic Tic-Tac-Toe rules and domain tests.
- [x] Define core PostgreSQL entities, append-only ledger tables and deferred balance triggers.
- [x] Add PostgreSQL migration runner with advisory lock, transactional application and SHA-256 drift detection.
- [x] Add local PostgreSQL Compose service.
- [ ] Generate and commit reproducible pnpm lockfile; get clean install/build/test/typecheck CI results.
- [ ] Validate migration and ledger triggers against PostgreSQL; add integration/rollback tests.
- [ ] Add dependency/secret scans and branch protection.

## Step 1 — Persistence and identity
- [ ] Registration, password hashing, verified email/phone, recovery, refresh rotation, MFA and session revocation.
- [ ] Permission registry, object-level policies, identity-provider boundary and audit trail.
- [ ] Tests for cross-account access, token reuse, brute force, enumeration, limits and recovery.

## Step 2 — Matchmaking and multiplayer
- [ ] Persist matches, invitations, acceptance, expiry, timeout and cancellation.
- [ ] Socket authentication and room authorization.
- [ ] Atomic match commands with versioning, row locks, idempotency and replay logs.
- [ ] Reconnect, ratings/history, reports, moderation, disputes and admin audit.
- [ ] Load/chaos tests for duplicate commands, stale versions, disconnects, restarts and colluding clients.

## Step 3 — Web and mobile clients
- [ ] Accessible responsive Next.js lobby/game/profile/history/challenge/notifications/safety app.
- [ ] Expo mobile app using server-owned game protocol and secure session storage.
- [ ] Shared API types/runtime validation; no UI-only authorization.
- [ ] Browser/mobile e2e tests for signup, play, reconnect, reporting and restrictions.

## Step 4 — Integrity and safeguards
- [ ] Versioned engine registry, action limits, replay verification and anti-cheat review.
- [ ] Eligibility/location policies, self-exclusion, cooling-off, limits and reminders.
- [ ] Abuse review, evidence preservation, appeals and reviewer audit.

## Step 5 — Ledger and providers (sandbox first)
- [ ] Transactional ledger posting service serializing concurrent balance operations.
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
- [ ] Capacity testing, observability, on-call alerts, backup restore drills and disaster recovery.
- [ ] Mobile release controls, crash monitoring, reconciliation, risk tuning, compliance reporting and access reviews.

A checkbox is complete only when code exists, tests exercise it and operational evidence is reviewed.
