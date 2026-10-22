ALTER TABLE users
  ADD COLUMN email text,
  ADD COLUMN password_hash text,
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN last_login_at timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_email_lowercase_chk
    CHECK (email IS NULL OR email = lower(email)),
  ADD CONSTRAINT users_password_hash_format_chk
    CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%');

CREATE UNIQUE INDEX users_email_lower_unique ON users (email) WHERE email IS NOT NULL;

CREATE TABLE roles (
  code text PRIMARY KEY,
  description text NOT NULL
);
INSERT INTO roles (code, description) VALUES
  ('PLAYER', 'Standard verified player'),
  ('MODERATOR', 'Player safety and content moderation'),
  ('SUPPORT_AGENT', 'Restricted support tools'),
  ('FINANCE_REVIEWER', 'Financial reconciliation review'),
  ('ADMINISTRATOR', 'Privileged platform operations');

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_code text NOT NULL REFERENCES roles(code),
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by_user_id uuid REFERENCES users(id),
  PRIMARY KEY (user_id, role_code)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_family_id uuid NOT NULL,
  refresh_token_hash char(64) NOT NULL UNIQUE,
  client_type text NOT NULL CHECK (client_type IN ('web','mobile')),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text,
  replaced_by_session_id uuid REFERENCES auth_sessions(id),
  user_agent_hash char(64),
  ip_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions(user_id, expires_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_family_idx ON auth_sessions(token_family_id, created_at DESC);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_pending_user_idx ON auth_tokens(user_id, purpose, expires_at DESC) WHERE consumed_at IS NULL;

CREATE TABLE game_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES game_matches(id),
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  request_digest char(64) NOT NULL,
  resulting_version bigint NOT NULL,
  response_state jsonb NOT NULL,
  response_status text NOT NULL CHECK (response_status IN ('IN_PROGRESS','COMPLETED','DRAW')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, command_id)
);
CREATE INDEX game_commands_actor_created_idx ON game_commands(actor_user_id, created_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;
