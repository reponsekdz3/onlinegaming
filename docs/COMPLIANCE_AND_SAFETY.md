# Regulatory, payment and player-safety gate

This is an engineering checklist, not legal advice. It does not claim the product is licensed.

## Rwanda confirmation required
Ask the competent Rwanda regulator / National Lottery & Gambling Commission and Rwanda-qualified counsel for written analysis of:
- Whether each proposed game is gambling, a game of skill, a prize competition or another regulated activity.
- Whether P2P stakes, platform commission, escrow, pooled stakes, tournaments and non-sports games are covered by an applicable licence.
- Licence holder, approved domains/apps, territories, advertising and promotion restrictions.
- Minimum age, identity, beneficial ownership, AML/customer due diligence, suspicious-activity reporting, records, tax and regulatory returns.
- Player-fund segregation, insolvency treatment, complaints/disputes and regulator access to records.
- Responsible-gambling duties, self-exclusion, cooling-off, limits, reminders and vulnerable-customer controls.
- Cross-border access, remote identity checks, geolocation and game-provider approvals.

RDB's 2025 directive references Law No. 58/2011, Ministerial Order No. 01/013/2013 and Ministerial Order No. 001/MINICOM/2023. It said the then-existing framework remained in force while new instruments were being reviewed and listed an expression-of-interest deadline of 30 September 2025 for online sports betting and casino. Verify current eligibility and the P2P model directly; do not infer authorization from that past notice.

## Payment providers
Get written approval for the exact licensed gambling use case and flows. Verify merchant entity, accounts, currencies, geography, refunds/chargebacks, payouts, webhook signatures, idempotency and reconciliation exports. Sandbox credentials are not production approval.

## Player protection
- Age and identity gate before regulated money features.
- Enforce self-exclusion and cooling-off in server-side authorization, matchmaking and money endpoints.
- Configurable session/deposit/loss limits and safe limit-increase rules where required.
- Prevent restriction bypass; detect multi-account abuse proportionately and provide appeals.
- Present rules, stake, fee, expiry, cancellation and dispute process before acceptance.
- Independent game-integrity review, anti-cheat telemetry and a route to dispute suspected manipulation.
- Never encourage chasing losses or patterns that bypass limits.

## Signed release attestation
The API checks a byte-for-byte signed Ed25519 release attestation. It requires schemaVersion 1, jurisdiction RW, productScope p2p_real_money, a licence reference and future expiry, provider approval references, independent audit reference, compliance sign-off, data-protection review and approval timestamp. The public key is separate. Default mode is disabled; a valid signature is not itself a legal determination. Evidence must be checked before the release key signs. Never commit its private key or real identity/payment data.

## Data protection and security
Record purposes, retention/deletion, data-subject requests and breach response. Minimize identity documents and payment data; prefer provider verification references over raw documents. Encrypt data in transit/at rest, scope production access, redact logs and review international data transfers. Threat-model account takeover, credential stuffing, replayed callbacks, collusion, insider abuse, stolen accounts, chargebacks, settlement races, denial of service and data leakage. Independent penetration testing and remediation are launch gates.
