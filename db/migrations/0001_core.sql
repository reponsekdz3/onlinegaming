BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handle text NOT NULL UNIQUE CHECK (length(handle) BETWEEN 3 AND 30),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  account_status text NOT NULL DEFAULT 'ACTIVE' CHECK (account_status IN ('ACTIVE','RESTRICTED','SUSPENDED','CLOSED')),
  identity_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (identity_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED')),
  age_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE games (
  slug text PRIMARY KEY,
  display_name text NOT NULL,
  engine_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO games (slug, display_name, engine_version, enabled)
VALUES ('tic-tac-toe', 'Tic-Tac-Toe', 'tic-tac-toe-v1', true);

CREATE TABLE game_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_slug text NOT NULL REFERENCES games(slug),
  status text NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','READY','IN_PROGRESS','COMPLETED','ABANDONED','DISPUTED')),
  player_x_id uuid REFERENCES users(id),
  player_o_id uuid REFERENCES users(id),
  current_version bigint NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  replay_digest text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (player_x_id IS NULL OR player_o_id IS NULL OR player_x_id <> player_o_id)
);
CREATE INDEX game_matches_status_created_idx ON game_matches(status, created_at DESC);
CREATE INDEX game_matches_player_x_idx ON game_matches(player_x_id, created_at DESC);
CREATE INDEX game_matches_player_o_idx ON game_matches(player_o_id, created_at DESC);

CREATE TABLE game_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES game_matches(id),
  sequence_no bigint NOT NULL CHECK (sequence_no > 0),
  actor_user_id uuid REFERENCES users(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  resulting_state_digest text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, sequence_no)
);
CREATE INDEX game_events_match_sequence_idx ON game_events(match_id, sequence_no);

CREATE TABLE player_safety_controls (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  self_excluded_until timestamptz,
  cooling_off_until timestamptz,
  session_limit_minutes integer CHECK (session_limit_minutes IS NULL OR session_limit_minutes > 0),
  daily_deposit_limit_minor bigint CHECK (daily_deposit_limit_minor IS NULL OR daily_deposit_limit_minor >= 0),
  daily_loss_limit_minor bigint CHECK (daily_loss_limit_minor IS NULL OR daily_loss_limit_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES users(id),
  account_code text NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  account_kind text NOT NULL CHECK (account_kind IN ('PLAYER_AVAILABLE','PLAYER_RESTRICTED','OPERATOR_CASH','STAKE_LIABILITY','PLAYER_PAYABLE','FEE_REVENUE','REFUNDS')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_player_account_unique ON ledger_accounts(owner_user_id, account_code, currency) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_platform_account_unique ON ledger_accounts(account_code, currency) WHERE owner_user_id IS NULL;

CREATE TABLE ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  transaction_type text NOT NULL CHECK (transaction_type IN ('DEPOSIT','WITHDRAWAL','STAKE_RESERVE','STAKE_RELEASE','PAYOUT','FEE','REFUND','ADJUSTMENT','REVERSAL')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  reverses_transaction_id uuid REFERENCES ledger_transactions(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_transactions_reference_idx ON ledger_transactions(reference_type, reference_id);
CREATE INDEX ledger_transactions_created_idx ON ledger_transactions(created_at DESC);

CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id uuid NOT NULL REFERENCES ledger_accounts(id),
  side text NOT NULL CHECK (side IN ('DEBIT','CREDIT')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries(transaction_id);
CREATE INDEX ledger_entries_account_created_idx ON ledger_entries(account_id, created_at DESC);

CREATE FUNCTION assert_ledger_transaction_balanced() RETURNS trigger AS $$
DECLARE
  target_transaction_id uuid;
  entry_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    target_transaction_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_transaction_id := OLD.transaction_id;
  ELSE
    target_transaction_id := NEW.transaction_id;
  END IF;

  SELECT count(*) INTO entry_count FROM ledger_entries WHERE transaction_id = target_transaction_id;
  IF entry_count < 2 THEN
    RAISE EXCEPTION 'Ledger transaction % must contain at least two entries', target_transaction_id;
  END IF;

  IF EXISTS (
    SELECT currency FROM ledger_entries
    WHERE transaction_id = target_transaction_id
    GROUP BY currency
    HAVING sum(CASE WHEN side = 'DEBIT' THEN amount_minor::numeric ELSE 0 END)
        <> sum(CASE WHEN side = 'CREDIT' THEN amount_minor::numeric ELSE 0 END)
  ) OR EXISTS (
    SELECT 1 FROM ledger_entries e
    JOIN ledger_transactions t ON t.id = e.transaction_id
    JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.transaction_id = target_transaction_id
      AND (e.currency <> t.currency OR e.currency <> a.currency)
  ) THEN
    RAISE EXCEPTION 'Ledger transaction % is not balanced by currency', target_transaction_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_header_balance_guard
  AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();
CREATE CONSTRAINT TRIGGER ledger_entry_balance_guard
  AFTER INSERT ON ledger_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_transaction_balanced();

CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Ledger records are append-only; write a compensating transaction';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TABLE wagers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES game_matches(id),
  player_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACCEPTED','RESERVED','SETTLED','VOID','DISPUTED')),
  idempotency_key text NOT NULL UNIQUE,
  terms_version text NOT NULL,
  reserve_transaction_id uuid REFERENCES ledger_transactions(id),
  settlement_transaction_id uuid REFERENCES ledger_transactions(id),
  accepted_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, player_id)
);
CREATE INDEX wagers_status_created_idx ON wagers(status, created_at DESC);

CREATE TABLE payment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  operation_type text NOT NULL CHECK (operation_type IN ('DEPOSIT','WITHDRAWAL')),
  provider text NOT NULL,
  provider_reference text,
  idempotency_key text NOT NULL UNIQUE,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','CONFIRMED','FAILED','CANCELLED','REVIEW_REQUIRED')),
  provider_signature_verified_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_provider_reference_unique ON payment_operations(provider, provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payment_operations_user_created_idx ON payment_operations(user_id, created_at DESC);

CREATE TABLE provider_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  signature_verified_at timestamptz,
  processing_status text NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED','VERIFIED','PROCESSED','REJECTED','RETRY_REQUIRED')),
  payload_digest text NOT NULL,
  processed_at timestamptz,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  actor_type text NOT NULL CHECK (actor_type IN ('USER','ADMIN','SYSTEM','PROVIDER')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  correlation_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, occurred_at DESC);

COMMIT;
