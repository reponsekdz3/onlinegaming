import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { SignJWT, jwtVerify } from "jose";
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";

function scryptAsync(password: string, salt: Buffer | string, keyLength: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}
const ACCESS_COOKIE = "og_access";
const REFRESH_COOKIE = "og_refresh";
const ACCESS_SECONDS = 15 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = "onlinegaming-api";
const AUDIENCE = "onlinegaming-client";

const RegisterSchema = z.object({
  handle: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/),
  displayName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128)
}).strict();

const LoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
  clientType: z.enum(["web", "mobile"]).default("web")
}).strict();

const TokenSchema = z.object({ token: z.string().min(32).max(256) }).strict();
const ResendSchema = z.object({ email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()) }).strict();
const ForgotSchema = ResendSchema;
const ResetSchema = z.object({
  token: z.string().min(32).max(256),
  newPassword: z.string().min(12).max(128)
}).strict();
const RefreshSchema = z.object({
  refreshToken: z.string().min(32).max(256).optional(),
  clientType: z.enum(["web", "mobile"]).optional()
}).strict();

export interface AuthPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  readonly handle: string;
  readonly displayName: string;
}

export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string
  ) {
    super(code);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenHash(value: string): string {
  return digest(value);
}

function accessKey(): Uint8Array {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("ACCESS_TOKEN_SECRET must contain at least 32 bytes.");
  }
  return new TextEncoder().encode(secret);
}

async function issueAccessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(accessKey());
}

function cookieOptions(maxAge: number, path: string) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path,
    maxAge
  };
}

function setSessionCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  reply.setCookie(ACCESS_COOKIE, accessToken, cookieOptions(ACCESS_SECONDS, "/api"));
  reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOptions(REFRESH_SECONDS, "/api/v1/auth"));
}

function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: "/api" });
  reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
}

function trustedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  const allowed = (process.env.WEB_ORIGINS ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000"))
    .split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(origin);
}

function requireTrustedOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (trustedOrigin(request)) return true;
  void reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
  return false;
}

function mailTransport(): Transporter | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) return null;
  const port = Number(process.env.SMTP_PORT ?? 1025);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === "true",
    ...(user && pass ? { auth: { user, pass } } : {}),
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000
  });
}

function publicAppUrl(path: string, token: string): string | null {
  const base = process.env.PUBLIC_APP_URL;
  if (!base) return null;
  try {
    const url = new URL(path, base);
    url.searchParams.set("token", token);
    return url.toString();
  } catch {
    return null;
  }
}

async function sendOneTimeToken(
  mailer: Transporter,
  email: string,
  purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET",
  token: string
): Promise<void> {
  const from = process.env.SMTP_FROM;
  const link = publicAppUrl(purpose === "EMAIL_VERIFICATION" ? "/verify-email" : "/reset-password", token);
  if (!from || !link) throw new Error("Mail sender configuration is incomplete.");
  const subject = purpose === "EMAIL_VERIFICATION" ? "Verify your OnlineGaming email" : "Reset your OnlineGaming password";
  const explanation = purpose === "EMAIL_VERIFICATION"
    ? "Confirm your email address to activate your account."
    : "Use this one-time link to choose a new password.";
  await mailer.sendMail({
    from,
    to: email,
    subject,
    text: explanation + "\n\n" + link + "\n\nThis link expires in 30 minutes. If you did not request this, ignore this message.",
    html: "<p>" + explanation + "</p><p><a href=\"" + link + "\">Continue securely</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this message.</p>"
  });
}

async function makePasswordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64, {
    N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }) as Buffer;
  return ["scrypt", "32768", "8", "1", salt.toString("base64url"), derived.toString("base64url")].join("$");
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "32768" || parts[2] !== "8" || parts[3] !== "1") {
    return false;
  }
  try {
    const salt = Buffer.from(parts[4]!, "base64url");
    const expected = Buffer.from(parts[5]!, "base64url");
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scryptAsync(password, salt, 64, {
      N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024
    }) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const dummyPasswordHash = await makePasswordHash(randomBytes(32).toString("hex"));

async function createAuthToken(
  client: PoolClient,
  userId: string,
  purpose: "EMAIL_VERIFICATION" | "PASSWORD_RESET"
): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await client.query(
    "UPDATE auth_tokens SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL",
    [userId, purpose]
  );
  await client.query(
    "INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,now() + interval '30 minutes')",
    [userId, purpose, tokenHash(raw)]
  );
  return raw;
}

async function createSession(
  client: PoolClient,
  request: FastifyRequest,
  userId: string,
  clientType: "web" | "mobile",
  tokenFamilyId: string = randomUUID()
): Promise<{ sessionId: string; accessToken: string; refreshToken: string }> {
  const sessionId = randomUUID();
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + REFRESH_SECONDS * 1000);
  await client.query(
    `INSERT INTO auth_sessions
      (id, user_id, token_family_id, refresh_token_hash, client_type, expires_at, user_agent_hash, ip_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      sessionId, userId, tokenFamilyId, tokenHash(refreshToken), clientType, expiresAt,
      request.headers["user-agent"] ? digest(request.headers["user-agent"]) : null,
      request.ip ? digest(request.ip) : null
    ]
  );
  return { sessionId, accessToken: await issueAccessToken(userId, sessionId), refreshToken };
}

function sendSessionResponse(
  reply: FastifyReply,
  session: { accessToken: string; refreshToken: string },
  clientType: "web" | "mobile",
  user: { id: string; handle: string; display_name: string; email: string; email_verified_at: Date | null }
) {
  if (clientType === "web") setSessionCookies(reply, session.accessToken, session.refreshToken);
  return reply.send({
    accessToken: session.accessToken,
    ...(clientType === "mobile" ? { refreshToken: session.refreshToken } : {}),
    tokenType: "Bearer",
    expiresIn: ACCESS_SECONDS,
    user: {
      id: user.id,
      handle: user.handle,
      displayName: user.display_name,
      email: user.email,
      emailVerified: Boolean(user.email_verified_at)
    }
  });
}

async function writeAudit(
  client: PoolClient,
  userId: string | null,
  action: string,
  targetType: string,
  targetId: string,
  outcome: "SUCCESS" | "DENIED" | "FAILURE",
  safeMetadata: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
      (actor_user_id, actor_type, action, target_type, target_id, correlation_id, outcome, safe_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [userId, userId ? "USER" : "SYSTEM", action, targetType, targetId, randomUUID(), outcome, JSON.stringify(safeMetadata)]
  );
}

export async function authenticateRequest(
  request: FastifyRequest,
  pool: Pool
): Promise<AuthPrincipal> {
  let token: string | undefined;
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) token = header.slice("Bearer ".length).trim();
  else token = request.cookies?.[ACCESS_COOKIE];

  if (!token) throw new AuthError(401, "AUTHENTICATION_REQUIRED");

  let userId: string;
  let sessionId: string;
  try {
    const verified = await jwtVerify(token, accessKey(), { issuer: ISSUER, audience: AUDIENCE });
    if (typeof verified.payload.sub !== "string" || typeof verified.payload.sid !== "string") {
      throw new Error("Invalid token claims");
    }
    userId = verified.payload.sub;
    sessionId = verified.payload.sid;
  } catch {
    throw new AuthError(401, "INVALID_OR_EXPIRED_ACCESS_TOKEN");
  }

  const result = await pool.query<{
    id: string; handle: string; display_name: string; account_status: string; email_verified_at: Date | null;
  }>(
    `SELECT u.id, u.handle, u.display_name, u.account_status, u.email_verified_at
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId, userId]
  );
  const user = result.rows[0];
  if (!user) throw new AuthError(401, "SESSION_REVOKED_OR_EXPIRED");
  if (user.account_status !== "ACTIVE") throw new AuthError(403, "ACCOUNT_NOT_ACTIVE");
  if (!user.email_verified_at) throw new AuthError(403, "EMAIL_VERIFICATION_REQUIRED");
  return { userId: user.id, sessionId, handle: user.handle, displayName: user.display_name };
}

export async function registerAuthRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post("/api/v1/auth/register", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REGISTRATION", details: parsed.error.flatten() });
    const mailer = mailTransport();
    if (!mailer || !process.env.PUBLIC_APP_URL) {
      return reply.code(503).send({ error: "EMAIL_DELIVERY_NOT_CONFIGURED" });
    }

    const { handle, displayName, email, password } = parsed.data;
    const passwordHash = await makePasswordHash(password);
    const client = await pool.connect();
    let user: { id: string; handle: string; display_name: string; email: string } | undefined;
    let verificationToken: string;
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string; handle: string; display_name: string; email: string }>(
        `INSERT INTO users (handle, display_name, email, password_hash)
         VALUES ($1,$2,$3,$4) RETURNING id, handle, display_name, email`,
        [handle, displayName, email, passwordHash]
      );
      user = inserted.rows[0]!;
      await client.query("INSERT INTO user_roles (user_id, role_code) VALUES ($1,'PLAYER')", [user.id]);
      verificationToken = await createAuthToken(client, user.id, "EMAIL_VERIFICATION");
      await writeAudit(client, user.id, "ACCOUNT_REGISTERED", "user", user.id, "SUCCESS");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code : undefined;
      if (code === "23505") return reply.code(409).send({ error: "HANDLE_OR_EMAIL_ALREADY_EXISTS" });
      request.log.error({ err: error }, "Registration transaction failed");
      return reply.code(500).send({ error: "REGISTRATION_FAILED" });
    } finally {
      client.release();
    }

    try {
      await sendOneTimeToken(mailer, email, "EMAIL_VERIFICATION", verificationToken!);
    } catch (error) {
      request.log.error({ err: error }, "Verification email could not be delivered");
      return reply.code(503).send({ error: "VERIFICATION_EMAIL_DELIVERY_FAILED", retryable: true });
    }
    return reply.code(202).send({
      status: "verification_required",
      message: "Check your email for a one-time verification link."
    });
  });

  app.post("/api/v1/auth/verify-email", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = TokenSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_VERIFICATION_TOKEN" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM auth_tokens
          WHERE token_hash = $1 AND purpose = 'EMAIL_VERIFICATION'
            AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash(parsed.data.token)]
      );
      const row = found.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "INVALID_OR_EXPIRED_VERIFICATION_TOKEN" });
      }
      await client.query("UPDATE auth_tokens SET consumed_at = now() WHERE id = $1", [row.id]);
      await client.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1", [row.user_id]);
      await writeAudit(client, row.user_id, "EMAIL_VERIFIED", "user", row.user_id, "SUCCESS");
      await client.query("COMMIT");
      return reply.send({ status: "verified", message: "Email verified. You can now sign in." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Email verification failed");
      return reply.code(500).send({ error: "EMAIL_VERIFICATION_FAILED" });
    } finally {
      client.release();
    }
  });

  app.post("/api/v1/auth/resend-verification", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = ResendSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_EMAIL" });
    const mailer = mailTransport();
    if (!mailer || !process.env.PUBLIC_APP_URL) return reply.code(503).send({ error: "EMAIL_DELIVERY_NOT_CONFIGURED" });
    const client = await pool.connect();
    let userId: string | undefined;
    let rawToken: string | undefined;
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 AND email_verified_at IS NULL AND account_status = 'ACTIVE' FOR UPDATE",
        [parsed.data.email]
      );
      userId = result.rows[0]?.id;
      if (userId) rawToken = await createAuthToken(client, userId, "EMAIL_VERIFICATION");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Unable to create verification token");
      return reply.code(500).send({ error: "VERIFICATION_TOKEN_CREATION_FAILED" });
    } finally {
      client.release();
    }
    if (userId && rawToken) {
      try { await sendOneTimeToken(mailer, parsed.data.email, "EMAIL_VERIFICATION", rawToken); }
      catch (error) {
        request.log.error({ err: error }, "Verification email resend failed");
        return reply.code(503).send({ error: "VERIFICATION_EMAIL_DELIVERY_FAILED", retryable: true });
      }
    }
    return reply.code(202).send({ status: "accepted", message: "If the account needs verification, instructions will be sent." });
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 8, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_LOGIN_REQUEST" });
    const { email, password, clientType } = parsed.data;
    const found = await pool.query<{
      id: string; handle: string; display_name: string; email: string; password_hash: string | null;
      email_verified_at: Date | null; account_status: string;
    }>(
      "SELECT id, handle, display_name, email, password_hash, email_verified_at, account_status FROM users WHERE email = $1",
      [email]
    );
    const user = found.rows[0];
    const passwordOk = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash);
    if (!user || !user.password_hash || !passwordOk) {
      return reply.code(401).send({ error: "INVALID_EMAIL_OR_PASSWORD" });
    }
    if (!user.email_verified_at) return reply.code(403).send({ error: "EMAIL_VERIFICATION_REQUIRED" });
    if (user.account_status !== "ACTIVE") return reply.code(403).send({ error: "ACCOUNT_NOT_ACTIVE" });

    const client = await pool.connect();
    let session: { accessToken: string; refreshToken: string };
    try {
      await client.query("BEGIN");
      session = await createSession(client, request, user.id, clientType);
      await client.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);
      await writeAudit(client, user.id, "LOGIN_SUCCEEDED", "user", user.id, "SUCCESS", { clientType });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Login session creation failed");
      return reply.code(500).send({ error: "LOGIN_FAILED" });
    } finally {
      client.release();
    }
    return sendSessionResponse(reply, session!, clientType, user);
  });

  app.post("/api/v1/auth/refresh", {
    config: { rateLimit: { max: 15, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = RefreshSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_REFRESH_REQUEST" });
    const suppliedToken = parsed.data.refreshToken ?? request.cookies?.[REFRESH_COOKIE];
    if (!suppliedToken) return reply.code(401).send({ error: "REFRESH_TOKEN_REQUIRED" });

    const client = await pool.connect();
    let sessionData: { sessionId: string; accessToken: string; refreshToken: string } | undefined;
    let userData: { id: string; handle: string; display_name: string; email: string; email_verified_at: Date | null } | undefined;
    let clientType: "web" | "mobile" = parsed.data.clientType ?? "web";
    let failure: "INVALID_REFRESH_TOKEN" | "REFRESH_TOKEN_REUSE_DETECTED" | "SESSION_EXPIRED" | "ACCOUNT_NOT_ACTIVE" | null = null;
    try {
      await client.query("BEGIN");
      const found = await client.query<{
        id: string; user_id: string; token_family_id: string; client_type: "web" | "mobile";
        expires_at: Date; revoked_at: Date | null; account_status: string;
        handle: string; display_name: string; email: string; email_verified_at: Date | null;
      }>(
        `SELECT s.id, s.user_id, s.token_family_id, s.client_type, s.expires_at, s.revoked_at,
                u.account_status, u.handle, u.display_name, u.email, u.email_verified_at
           FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.refresh_token_hash = $1 FOR UPDATE OF s`,
        [tokenHash(suppliedToken)]
      );
      const old = found.rows[0];
      if (!old) {
        failure = "INVALID_REFRESH_TOKEN";
      } else if (old.revoked_at) {
        await client.query(
          "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'refresh_reuse_detected') WHERE token_family_id = $1",
          [old.token_family_id]
        );
        await writeAudit(client, old.user_id, "REFRESH_TOKEN_REUSE_DETECTED", "auth_session", old.id, "DENIED");
        failure = "REFRESH_TOKEN_REUSE_DETECTED";
      } else if (new Date(old.expires_at).getTime() <= Date.now()) {
        await client.query("UPDATE auth_sessions SET revoked_at = now(), revocation_reason = 'expired' WHERE id = $1", [old.id]);
        failure = "SESSION_EXPIRED";
      } else if (old.account_status !== "ACTIVE" || !old.email_verified_at) {
        await client.query("UPDATE auth_sessions SET revoked_at = now(), revocation_reason = 'account_not_active' WHERE id = $1", [old.id]);
        failure = "ACCOUNT_NOT_ACTIVE";
      } else {
        clientType = parsed.data.clientType ?? old.client_type;
        if (clientType !== old.client_type) {
          failure = "INVALID_REFRESH_TOKEN";
        } else {
          const replacement = await createSession(client, request, old.user_id, clientType, old.token_family_id);
          await client.query(
            "UPDATE auth_sessions SET revoked_at = now(), revocation_reason = 'rotated', replaced_by_session_id = $2, last_used_at = now() WHERE id = $1",
            [old.id, replacement.sessionId]
          );
          await writeAudit(client, old.user_id, "SESSION_REFRESHED", "auth_session", old.id, "SUCCESS");
          sessionData = replacement;
          userData = {
            id: old.user_id, handle: old.handle, display_name: old.display_name,
            email: old.email, email_verified_at: old.email_verified_at
          };
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Session rotation failed");
      return reply.code(500).send({ error: "SESSION_REFRESH_FAILED" });
    } finally {
      client.release();
    }
    if (failure) return reply.code(401).send({ error: failure });
    if (!sessionData || !userData) return reply.code(401).send({ error: "INVALID_REFRESH_TOKEN" });
    return sendSessionResponse(reply, sessionData, clientType, userData);
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = RefreshSchema.safeParse(request.body ?? {});
    const refresh = parsed.success ? parsed.data.refreshToken ?? request.cookies?.[REFRESH_COOKIE] : request.cookies?.[REFRESH_COOKIE];
    if (refresh) {
      await pool.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'logout') WHERE refresh_token_hash = $1",
        [tokenHash(refresh)]
      );
    }
    clearSessionCookies(reply);
    return reply.send({ status: "logged_out" });
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    try {
      const principal = await authenticateRequest(request, pool);
      const result = await pool.query<{ id: string; handle: string; display_name: string; email: string; email_verified_at: Date; roles: string[] }>(
        `SELECT u.id, u.handle, u.display_name, u.email, u.email_verified_at,
                COALESCE(array_agg(ur.role_code) FILTER (WHERE ur.role_code IS NOT NULL), ARRAY[]::text[]) AS roles
           FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
          WHERE u.id = $1 GROUP BY u.id`,
        [principal.userId]
      );
      const user = result.rows[0];
      if (!user) return reply.code(401).send({ error: "SESSION_USER_NOT_FOUND" });
      return reply.send({
        id: user.id, handle: user.handle, displayName: user.display_name, email: user.email,
        emailVerified: Boolean(user.email_verified_at), roles: user.roles
      });
    } catch (error) {
      if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.code });
      request.log.error({ err: error }, "Could not read authenticated profile");
      return reply.code(500).send({ error: "PROFILE_LOOKUP_FAILED" });
    }
  });

  app.post("/api/v1/auth/password/forgot", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = ForgotSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_EMAIL" });
    const mailer = mailTransport();
    if (!mailer || !process.env.PUBLIC_APP_URL) return reply.code(503).send({ error: "EMAIL_DELIVERY_NOT_CONFIGURED" });
    const client = await pool.connect();
    let userId: string | undefined;
    let rawToken: string | undefined;
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE email = $1 AND email_verified_at IS NOT NULL AND account_status = 'ACTIVE' FOR UPDATE",
        [parsed.data.email]
      );
      userId = found.rows[0]?.id;
      if (userId) rawToken = await createAuthToken(client, userId, "PASSWORD_RESET");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Password reset token creation failed");
      return reply.code(500).send({ error: "PASSWORD_RESET_REQUEST_FAILED" });
    } finally {
      client.release();
    }
    if (userId && rawToken) {
      try { await sendOneTimeToken(mailer, parsed.data.email, "PASSWORD_RESET", rawToken); }
      catch (error) {
        request.log.error({ err: error }, "Password reset email failed");
        return reply.code(503).send({ error: "PASSWORD_RESET_EMAIL_DELIVERY_FAILED", retryable: true });
      }
    }
    return reply.code(202).send({ status: "accepted", message: "If a verified account exists for this email, instructions will be sent." });
  });

  app.post("/api/v1/auth/password/reset", {
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!requireTrustedOrigin(request, reply)) return;
    const parsed = ResetSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PASSWORD_RESET_REQUEST" });
    const passwordHash = await makePasswordHash(parsed.data.newPassword);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const found = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM auth_tokens
          WHERE token_hash = $1 AND purpose = 'PASSWORD_RESET'
            AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [tokenHash(parsed.data.token)]
      );
      const token = found.rows[0];
      if (!token) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "INVALID_OR_EXPIRED_PASSWORD_RESET_TOKEN" });
      }
      await client.query("UPDATE auth_tokens SET consumed_at = now() WHERE id = $1", [token.id]);
      await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [token.user_id, passwordHash]);
      await client.query(
        "UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, now()), revocation_reason = COALESCE(revocation_reason, 'password_reset') WHERE user_id = $1",
        [token.user_id]
      );
      await writeAudit(client, token.user_id, "PASSWORD_RESET_COMPLETED", "user", token.user_id, "SUCCESS");
      await client.query("COMMIT");
      clearSessionCookies(reply);
      return reply.send({ status: "password_reset", message: "Password updated. Sign in again on your devices." });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      request.log.error({ err: error }, "Password reset failed");
      return reply.code(500).send({ error: "PASSWORD_RESET_FAILED" });
    } finally {
      client.release();
    }
  });
}
