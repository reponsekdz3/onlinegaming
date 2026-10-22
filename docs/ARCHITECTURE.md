# Architecture and system boundaries

## Guiding decisions
1. Begin with a TypeScript modular monolith and PostgreSQL as source of truth; money and match transitions require one transaction boundary.
2. Never trust the client for game state, timing, eligibility, balances, payment confirmation or result settlement.
3. Commit state and versioned events before broadcasting accepted game state.
4. Redis is for ephemeral presence/rate limits only; losing it must not erase matches, ledger entries or provider references.
5. Domain modules isolate game engines, identity verification, payment providers and regulator reporting.

## Bounded modules
- Identity/access: sessions, MFA, recovery, device history, explicit role/permission registry and object-level policies.
- Player safety: age/eligibility, self-exclusion, cooling-off, limits, reminders and restrictions.
- Game catalogue: published game-engine versions and validated configuration.
- Matchmaking: queue admission, invitations, timeouts and anti-abuse controls.
- Game runtime: room lifecycle, authoritative state machine, reconnect and replay logs.
- Social: friends, block/report, moderated chat, notifications and tournaments.
- Wagering: offer/accept/lock/void/dispute/settle state machines; disabled until legal release.
- Payments: intents, provider adapters, signature-verified webhook inbox, idempotency, reconciliation and withdrawal review.
- Ledger: balanced append-only double-entry journal, holds and compensating entries.
- Risk/admin: collusion signals, review cases, dual approval, re-authentication and audit trail.

## Real-time protocol
1. Authenticate each socket with a short-lived server-issued credential; reject expired, suspended or restricted accounts.
2. Authorize every room join and command; never trust a client-provided player role.
3. Commands include match ID, command ID, expected version and validated action.
4. Lock the match row, check version and turn, apply versioned engine rules, append the event and update state/version in one database transaction.
5. Broadcast only committed state. Deduplicate retries by command ID. Stale versions get a conflict and authoritative state.
6. Reconnect returns an authorized snapshot plus events after the last acknowledged sequence.
7. Disputes block settlement and require auditable review; privileged resolution requires dual control.

## Financial protocol
- A payment request creates an idempotent operation, not a balance increase.
- Verify provider signature, merchant, user, amount, currency, reference and permitted state transition.
- Store the provider event in an inbox before processing; unique provider/event ID prevents duplicate processing.
- Confirmation and its balanced journal transaction commit atomically. Withdrawal funds are reserved before submission and reconciled.
- Match completion alone is not proof of a payable result. Settlement also requires eligibility, allowed market/rule version, no risk/dispute hold and a unique idempotency key.
- Reconcile provider statements, operations and ledger movements; differences are held and alerted.

## Operations
Reviewed migrations, correlation IDs, redacted structured logs, metrics, alerts, verified backups, restore drills, graceful shutdown, named permissions and accurate implementation status are mandatory. Unimplemented functionality must not return success-shaped responses.
