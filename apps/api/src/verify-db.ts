import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for database verification.");

const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  connectionTimeoutMillis: 5_000,
  ...(process.env.PGSSL === "true" ? { ssl: { rejectUnauthorized: true } } : {})
});

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function verifyDatabaseInvariants(): Promise<void> {
  const client = await pool.connect();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 18);
  try {
    const firstUser = await client.query<{ id: string }>(
      "INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id",
      ["ci_a_" + suffix, "CI verification A"]
    );
    const secondUser = await client.query<{ id: string }>(
      "INSERT INTO users (handle, display_name) VALUES ($1, $2) RETURNING id",
      ["ci_b_" + suffix, "CI verification B"]
    );
    const firstAccount = await client.query<{ id: string }>(
      "INSERT INTO ledger_accounts (owner_user_id, account_code, currency, account_kind) VALUES ($1,$2,'RWF','PLAYER_AVAILABLE') RETURNING id",
      [firstUser.rows[0]!.id, "CI_AVAILABLE_" + suffix]
    );
    const secondAccount = await client.query<{ id: string }>(
      "INSERT INTO ledger_accounts (owner_user_id, account_code, currency, account_kind) VALUES ($1,$2,'RWF','PLAYER_RESTRICTED') RETURNING id",
      [secondUser.rows[0]!.id, "CI_RESTRICTED_" + suffix]
    );

    await client.query("BEGIN");
    const balanced = await client.query<{ id: string }>(
      "INSERT INTO ledger_transactions (idempotency_key, transaction_type, currency, reference_type, reference_id) VALUES ($1,'ADJUSTMENT','RWF','ci_verify',$2) RETURNING id",
      ["ci-balanced-" + suffix, suffix]
    );
    await client.query(
      "INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency) VALUES ($1,$2,'DEBIT',100,'RWF'),($1,$3,'CREDIT',100,'RWF')",
      [balanced.rows[0]!.id, firstAccount.rows[0]!.id, secondAccount.rows[0]!.id]
    );
    await client.query("COMMIT");

    await client.query("BEGIN");
    const unbalanced = await client.query<{ id: string }>(
      "INSERT INTO ledger_transactions (idempotency_key, transaction_type, currency, reference_type, reference_id) VALUES ($1,'ADJUSTMENT','RWF','ci_verify',$2) RETURNING id",
      ["ci-unbalanced-" + suffix, suffix]
    );
    await client.query(
      "INSERT INTO ledger_entries (transaction_id, account_id, side, amount_minor, currency) VALUES ($1,$2,'DEBIT',101,'RWF'),($1,$3,'CREDIT',100,'RWF')",
      [unbalanced.rows[0]!.id, firstAccount.rows[0]!.id, secondAccount.rows[0]!.id]
    );
    let unbalancedRejected = false;
    try {
      await client.query("COMMIT");
    } catch {
      unbalancedRejected = true;
      await client.query("ROLLBACK");
    }
    assert(unbalancedRejected, "Database accepted an unbalanced ledger transaction.");

    await client.query("BEGIN");
    let mutationRejected = false;
    try {
      await client.query(
        "UPDATE ledger_entries SET amount_minor = amount_minor + 1 WHERE transaction_id = $1",
        [balanced.rows[0]!.id]
      );
      await client.query("COMMIT");
    } catch {
      mutationRejected = true;
      await client.query("ROLLBACK");
    }
    assert(mutationRejected, "Database allowed a ledger entry to be edited in place.");
    console.info("Database verification passed: balanced posting accepted; unbalanced posting and ledger mutation rejected.");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

verifyDatabaseInvariants().catch((error: unknown) => {
  console.error("Database invariant verification failed:", error);
  process.exitCode = 1;
});
