import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  addMoney, applyTicTacToeMove, createTicTacToeState,
  evaluateRealMoneyGate, money, parseMinorUnits, subtractMoney
} from "../src/index.js";

describe("integer money primitives", () => {
  it("adds and subtracts minor units without floating-point arithmetic", () => {
    expect(addMoney(money(199n, "RWF"), money(2n, "RWF"))).toEqual({ amountMinor: 201n, currency: "RWF" });
    expect(subtractMoney(money(201n, "RWF"), money(1n, "RWF"))).toEqual({ amountMinor: 200n, currency: "RWF" });
  });
  it("rejects negative amounts, malformed values and currency mismatches", () => {
    expect(() => money(-1n, "RWF")).toThrow();
    expect(() => parseMinorUnits("1.2", "RWF")).toThrow();
    expect(() => addMoney(money(1n, "RWF"), money(1n, "USD"))).toThrow();
    expect(() => subtractMoney(money(1n, "RWF"), money(2n, "RWF"))).toThrow();
  });
});

describe("authoritative Tic-Tac-Toe rules", () => {
  it("rejects out-of-turn, occupied and out-of-range moves", () => {
    const initial = createTicTacToeState();
    expect(() => applyTicTacToeMove(initial, "O", 0)).toThrow("NOT_PLAYERS_TURN");
    const next = applyTicTacToeMove(initial, "X", 0);
    expect(() => applyTicTacToeMove(next, "O", 0)).toThrow("CELL_ALREADY_OCCUPIED");
    expect(() => applyTicTacToeMove(initial, "X", 9)).toThrow("INVALID_CELL");
  });
  it("derives the winner from validated moves rather than client claims", () => {
    let state = createTicTacToeState();
    state = applyTicTacToeMove(state, "X", 0);
    state = applyTicTacToeMove(state, "O", 3);
    state = applyTicTacToeMove(state, "X", 1);
    state = applyTicTacToeMove(state, "O", 4);
    state = applyTicTacToeMove(state, "X", 2);
    expect(state.status).toBe("COMPLETED");
    expect(state.winner).toBe("X");
    expect(() => applyTicTacToeMove(state, "O", 5)).toThrow("MATCH_ALREADY_FINISHED");
  });
});

describe("real-money launch release gate", () => {
  it("fails closed when not explicitly enabled", () => {
    expect(evaluateRealMoneyGate({}).enabled).toBe(false);
    expect(evaluateRealMoneyGate({ WAGERING_MODE: "enabled" }).reason).toBe("ATTESTATION_MISSING");
  });
  it("requires a valid signed attestation and an unexpired licence reference", () => {
    const keys = generateKeyPairSync("ed25519");
    const payload = JSON.stringify({
      schemaVersion: 1, jurisdiction: "RW", productScope: "p2p_real_money",
      licenseReference: "license-evidence-reference", licenseValidUntil: "2030-01-01T00:00:00.000Z",
      paymentProviderApprovalReferences: ["provider-approval-evidence"],
      independentAuditReference: "audit-evidence", complianceSignoffReference: "compliance-evidence",
      dataProtectionReviewReference: "privacy-review-evidence", approvedAt: "2026-01-01T00:00:00.000Z"
    });
    const signature = sign(null, Buffer.from(payload, "utf8"), keys.privateKey).toString("base64");
    const env = {
      WAGERING_MODE: "enabled", WAGERING_RELEASE_ATTESTATION_JSON: payload,
      WAGERING_RELEASE_PUBLIC_KEY_PEM: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      WAGERING_RELEASE_SIGNATURE_BASE64: signature
    };
    expect(evaluateRealMoneyGate(env, new Date("2027-01-01T00:00:00.000Z")).enabled).toBe(true);
    expect(evaluateRealMoneyGate({ ...env, WAGERING_RELEASE_SIGNATURE_BASE64: "invalid" }).enabled).toBe(false);
    expect(evaluateRealMoneyGate(env, new Date("2031-01-01T00:00:00.000Z")).reason).toBe("ATTESTATION_EXPIRED");
  });
});
