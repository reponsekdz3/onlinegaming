import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  applyTicTacToeMove,
  createTicTacToeState,
  type TicTacToeState
} from "@onlinegaming/domain";
import { authenticateRequest, AuthError } from "./auth.js";
import { z } from "zod";

const MatchParams = z.object({ matchId: z.string().uuid() }).strict();
const CreateMatchBody = z.object({ gameSlug: z.literal("tic-tac-toe").default("tic-tac-toe") }).strict();
const MoveBody = z.object({
  commandId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  cellIndex: z.number().int().min(0).max(8)
}).strict();

interface MatchRow {
  id: string;
  game_slug: string;
  status: string;
  player_x_id: string | null;
  player_o_id: string | null;
  current_version: string | number;
  state: TicTacToeState;
  result: Record<string, unknown> | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function stateDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function publicMatch(row: MatchRow, viewerId: string, playerXHandle?: string | null, playerOHandle?: string | null) {
  const playerRole = row.player_x_id === viewerId ? "X" : row.player_o_id === viewerId ? "O" : null;
  return {
    id: row.id,
    gameSlug: row.game_slug,
    status: row.status,
    version: Number(row.current_version),
    state: row.state,
    result: row.result,
    playerRole,
    players: {
      X: row.player_x_id ? { id: row.player_x_id, handle: playerXHandle ?? null } : null,
      O: row.player_o_id ? { id: row.player_o_id, handle: playerOHandle ?? null } : null
    },
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}

async function getPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  pool: Pool
) {
  try {
    return await authenticateRequest(request, pool);
  } catch (error) {
    if (error instanceof AuthError) {
      await reply.code(error.statusCode).send({ error: error.code });
    } else {
      request.log.error({ err: error }, "Authentication check failed");
      await reply.code(500).send({ error: "AUTHENTICATION_CHECK_FAILED" });
    }
    return null;
  }
}

async function auditMatchEvent(
  client: PoolClient,
  userId: string,
  action: string,
  matchId: string,
  outcome: "SUCCESS" | "DENIED" | "FAILURE" = "SUCCESS",
  safeMetadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_user_id, actor_type, action, target_type, target_id, correlation_id, outcome, safe_metadata)
     VALUES ($1,'USER',$2,'game_match',$3,$4,$5,$6)`,
    [userId, action, matchId, randomUUID(), outcome, JSON.stringify(safeMetadata)]
  );
}

export async function registerMatchRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post("/api/v1/matches", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const principal = await getPrincipal(request, reply, pool);
    if (!principal) return;
    const parsed = CreateMatchBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MATCH_REQUEST" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const game = await client.query<{ slug: string; engine_version: string }>(
        "SELECT slug, engine_version FROM games WHERE slug = $1 AND enabled = true",
        [parsed.data.gameSlug]
      );
      const engine = game.rows[0];
      if (!engine) {
        await client.query("ROLLBACK");
        return reply.code(422).send({ error: "GAME_NOT_AVAILABLE" });
      }
      const initialState = createTicTacToeState();
      const inserted = await client.query<MatchRow>(
        `INSERT INTO game_matches (game_slug, status, player_x_id, current_version, state)
         VALUES ($1,'WAITING',$2,0,$3::jsonb)
         RETURNING id, game_slug, status, player_x_id, player_o_id, current_version, state, result, created_at, started_at, completed_at`,
        [engine.slug, principal.userId, JSON.stringify(initialState)]
      );
      const match = inserted.rows[0]!;
      await auditMatchEvent(client, principal.userId, "MATCH_CREATED", match.id, "SUCCESS", { gameSlug: engine.slug });
      await client.query("COMMIT");
      return reply.code(201).send({
        match: publicMatch(match, principal.userId, principal.handle, null),
        matchmaking: { mode: "open_challenge", stake: "disabled" }
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Could not create match");
      return reply.code(500).send({ error: "MATCH_CREATION_FAILED" });
    } finally {
      client.release();
    }
  });

  app.get("/api/v1/matches", async (request, reply) => {
    const principal = await getPrincipal(request, reply, pool);
    if (!principal) return;
    const querySchema = z.object({
      mode: z.enum(["waiting", "mine"]).default("waiting"),
      limit: z.coerce.number().int().min(1).max(50).default(20)
    }).strict();
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MATCH_QUERY" });

    if (parsed.data.mode === "waiting") {
      const result = await pool.query<MatchRow & { player_x_handle: string }>(
        `SELECT m.id, m.game_slug, m.status, m.player_x_id, m.player_o_id, m.current_version,
                m.state, m.result, m.created_at, m.started_at, m.completed_at,
                u.handle AS player_x_handle
           FROM game_matches m JOIN users u ON u.id = m.player_x_id
          WHERE m.status = 'WAITING' AND m.player_o_id IS NULL AND m.player_x_id <> $1
          ORDER BY m.created_at ASC LIMIT $2`,
        [principal.userId, parsed.data.limit]
      );
      return reply.send({
        mode: "waiting",
        matches: result.rows.map((row) => publicMatch(row, principal.userId, row.player_x_handle, null))
      });
    }

    const result = await pool.query<MatchRow & { player_x_handle: string | null; player_o_handle: string | null }>(
      `SELECT m.id, m.game_slug, m.status, m.player_x_id, m.player_o_id, m.current_version,
              m.state, m.result, m.created_at, m.started_at, m.completed_at,
              ux.handle AS player_x_handle, uo.handle AS player_o_handle
         FROM game_matches m
         LEFT JOIN users ux ON ux.id = m.player_x_id
         LEFT JOIN users uo ON uo.id = m.player_o_id
        WHERE m.player_x_id = $1 OR m.player_o_id = $1
        ORDER BY m.created_at DESC LIMIT $2`,
      [principal.userId, parsed.data.limit]
    );
    return reply.send({
      mode: "mine",
      matches: result.rows.map((row) =>
        publicMatch(row, principal.userId, row.player_x_handle, row.player_o_handle))
    });
  });

  app.post("/api/v1/matches/:matchId/join", {
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const principal = await getPrincipal(request, reply, pool);
    if (!principal) return;
    const params = MatchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_MATCH_ID" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<MatchRow>(
        `SELECT id, game_slug, status, player_x_id, player_o_id, current_version, state, result, created_at, started_at, completed_at
           FROM game_matches WHERE id = $1 FOR UPDATE`,
        [params.data.matchId]
      );
      const match = selected.rows[0];
      if (!match) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "MATCH_NOT_FOUND" });
      }
      if (match.player_x_id === principal.userId) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "CANNOT_JOIN_OWN_MATCH" });
      }
      if (match.status !== "WAITING" || match.player_o_id !== null) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "MATCH_NOT_AVAILABLE" });
      }
      const state = createTicTacToeState();
      const startVersion = 1;
      const updated = await client.query<MatchRow>(
        `UPDATE game_matches SET status = 'IN_PROGRESS', player_o_id = $2,
              current_version = $3, state = $4::jsonb, started_at = now()
          WHERE id = $1
        RETURNING id, game_slug, status, player_x_id, player_o_id, current_version, state, result, created_at, started_at, completed_at`,
        [match.id, principal.userId, startVersion, JSON.stringify(state)]
      );
      await client.query(
        `INSERT INTO game_events (match_id, sequence_no, actor_user_id, event_type, payload, resulting_state_digest)
         VALUES ($1,$2,$3,'MATCH_STARTED',$4::jsonb,$5)`,
        [match.id, startVersion, principal.userId, JSON.stringify({ gameSlug: match.game_slug, engineVersion: "tic-tac-toe-v1" }), stateDigest(state)]
      );
      await auditMatchEvent(client, principal.userId, "MATCH_JOINED", match.id);
      await client.query("COMMIT");
      return reply.send({ match: publicMatch(updated.rows[0]!, principal.userId, null, principal.handle) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Could not join match");
      return reply.code(500).send({ error: "MATCH_JOIN_FAILED" });
    } finally {
      client.release();
    }
  });

  app.get("/api/v1/matches/:matchId", async (request, reply) => {
    const principal = await getPrincipal(request, reply, pool);
    if (!principal) return;
    const params = MatchParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_MATCH_ID" });
    const result = await pool.query<MatchRow & { player_x_handle: string | null; player_o_handle: string | null }>(
      `SELECT m.id, m.game_slug, m.status, m.player_x_id, m.player_o_id, m.current_version,
              m.state, m.result, m.created_at, m.started_at, m.completed_at,
              ux.handle AS player_x_handle, uo.handle AS player_o_handle
         FROM game_matches m
         LEFT JOIN users ux ON ux.id = m.player_x_id
         LEFT JOIN users uo ON uo.id = m.player_o_id
        WHERE m.id = $1`,
      [params.data.matchId]
    );
    const match = result.rows[0];
    if (!match) return reply.code(404).send({ error: "MATCH_NOT_FOUND" });
    if (match.player_x_id !== principal.userId && match.player_o_id !== principal.userId) {
      return reply.code(403).send({ error: "MATCH_ACCESS_DENIED" });
    }
    return reply.send({ match: publicMatch(match, principal.userId, match.player_x_handle, match.player_o_handle) });
  });

  app.post("/api/v1/matches/:matchId/moves", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const principal = await getPrincipal(request, reply, pool);
    if (!principal) return;
    const params = MatchParams.safeParse(request.params);
    const parsed = MoveBody.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "INVALID_MATCH_ID" });
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_MOVE_REQUEST" });

    const { commandId, expectedVersion, cellIndex } = parsed.data;
    const requestDigest = stateDigest({ actorId: principal.userId, expectedVersion, cellIndex });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<MatchRow>(
        `SELECT id, game_slug, status, player_x_id, player_o_id, current_version, state, result, created_at, started_at, completed_at
           FROM game_matches WHERE id = $1 FOR UPDATE`,
        [params.data.matchId]
      );
      const match = selected.rows[0];
      if (!match) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "MATCH_NOT_FOUND" });
      }
      const isX = match.player_x_id === principal.userId;
      const isO = match.player_o_id === principal.userId;
      if (!isX && !isO) {
        await client.query("ROLLBACK");
        return reply.code(403).send({ error: "MATCH_ACCESS_DENIED" });
      }

      const duplicate = await client.query<{
        actor_user_id: string;
        request_digest: string;
        resulting_version: string | number;
        response_state: TicTacToeState;
        response_status: string;
      }>(
        `SELECT actor_user_id, request_digest, resulting_version, response_state, response_status
           FROM game_commands WHERE match_id = $1 AND command_id = $2`,
        [match.id, commandId]
      );
      const prior = duplicate.rows[0];
      if (prior) {
        if (prior.actor_user_id !== principal.userId || prior.request_digest !== requestDigest) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: "COMMAND_ID_REUSED_WITH_DIFFERENT_REQUEST" });
        }
        await client.query("COMMIT");
        return reply.send({
          matchId: match.id,
          version: Number(prior.resulting_version),
          state: prior.response_state,
          status: prior.response_status,
          duplicate: true
        });
      }

      if (match.status !== "IN_PROGRESS") {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "MATCH_NOT_IN_PROGRESS" });
      }
      const currentVersion = Number(match.current_version);
      if (expectedVersion !== currentVersion) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: "STALE_MATCH_VERSION",
          expectedVersion,
          currentVersion
        });
      }

      let nextState: TicTacToeState;
      const playerMark = isX ? "X" : "O";
      try {
        nextState = applyTicTacToeMove(match.state, playerMark, cellIndex);
      } catch (error) {
        await client.query("ROLLBACK");
        const code = error instanceof Error ? error.message : "INVALID_MOVE";
        return reply.code(409).send({ error: code });
      }

      const version = currentVersion + 1;
      const isFinished = nextState.status === "COMPLETED" || nextState.status === "DRAW";
      const status = isFinished ? "COMPLETED" : "IN_PROGRESS";
      const resultPayload = isFinished ? {
        status: nextState.status,
        winnerMark: nextState.winner,
        winnerUserId: nextState.winner === null ? null : nextState.winner === "X" ? match.player_x_id : match.player_o_id,
        moveCount: nextState.moveCount,
        engineVersion: "tic-tac-toe-v1"
      } : null;

      await client.query(
        `UPDATE game_matches SET current_version = $2, state = $3::jsonb, status = $4,
              result = $5::jsonb, completed_at = CASE WHEN $6 THEN now() ELSE completed_at END
          WHERE id = $1`,
        [match.id, version, JSON.stringify(nextState), status, resultPayload ? JSON.stringify(resultPayload) : null, isFinished]
      );
      await client.query(
        `INSERT INTO game_events (match_id, sequence_no, actor_user_id, event_type, payload, resulting_state_digest)
         VALUES ($1,$2,$3,'PLAYER_MOVE',$4::jsonb,$5)`,
        [match.id, version, principal.userId, JSON.stringify({ commandId, cellIndex, mark: playerMark, expectedVersion }), stateDigest(nextState)]
      );
      await client.query(
        `INSERT INTO game_commands
           (match_id, command_id, actor_user_id, request_digest, resulting_version, response_state, response_status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [match.id, commandId, principal.userId, requestDigest, version, JSON.stringify(nextState), nextState.status]
      );
      if (isFinished) {
        await auditMatchEvent(client, principal.userId, "MATCH_FINISHED", match.id, "SUCCESS", resultPayload ?? {});
      }
      await client.query("COMMIT");
      return reply.send({
        matchId: match.id,
        version,
        state: nextState,
        status: nextState.status,
        result: resultPayload,
        duplicate: false
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Move transaction failed");
      return reply.code(500).send({ error: "MOVE_COULD_NOT_BE_COMMITTED" });
    } finally {
      client.release();
    }
  });
}
