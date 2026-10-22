import { createPublicKey, verify as verifySignature } from "node:crypto";

export type RealMoneyGateReason =
  | "MODE_DISABLED" | "ATTESTATION_MISSING" | "PUBLIC_KEY_MISSING" | "SIGNATURE_MISSING"
  | "ATTESTATION_INVALID" | "SIGNATURE_INVALID" | "ATTESTATION_EXPIRED" | "ATTESTATION_NOT_YET_VALID";

export interface RealMoneyGateResult {
  readonly enabled: boolean;
  readonly reason: RealMoneyGateReason | "AUTHORIZED_RELEASE_ATTESTATION_VERIFIED";
}

interface ReleaseAttestation {
  schemaVersion: 1;
  jurisdiction: "RW";
  productScope: "p2p_real_money";
  licenseReference: string;
  licenseValidUntil: string;
  paymentProviderApprovalReferences: string[];
  independentAuditReference: string;
  complianceSignoffReference: string;
  dataProtectionReviewReference: string;
  approvedAt: string;
}

export function evaluateRealMoneyGate(
  env: Record<string, string | undefined>,
  now = new Date()
): RealMoneyGateResult {
  if (env.WAGERING_MODE !== "enabled") return { enabled: false, reason: "MODE_DISABLED" };
  const payload = env.WAGERING_RELEASE_ATTESTATION_JSON;
  if (!payload) return { enabled: false, reason: "ATTESTATION_MISSING" };
  const publicKey = env.WAGERING_RELEASE_PUBLIC_KEY_PEM;
  if (!publicKey) return { enabled: false, reason: "PUBLIC_KEY_MISSING" };
  const signature = env.WAGERING_RELEASE_SIGNATURE_BASE64;
  if (!signature) return { enabled: false, reason: "SIGNATURE_MISSING" };

  let attestation: ReleaseAttestation;
  try {
    attestation = JSON.parse(payload) as ReleaseAttestation;
    validateAttestation(attestation);
  } catch {
    return { enabled: false, reason: "ATTESTATION_INVALID" };
  }

  let signatureIsValid = false;
  try {
    signatureIsValid = verifySignature(
      null, Buffer.from(payload, "utf8"), createPublicKey(publicKey), Buffer.from(signature, "base64")
    );
  } catch {
    signatureIsValid = false;
  }
  if (!signatureIsValid) return { enabled: false, reason: "SIGNATURE_INVALID" };

  const approvedAt = Date.parse(attestation.approvedAt);
  if (!Number.isFinite(approvedAt) || approvedAt > now.getTime()) {
    return { enabled: false, reason: "ATTESTATION_NOT_YET_VALID" };
  }
  const expiry = Date.parse(attestation.licenseValidUntil);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    return { enabled: false, reason: "ATTESTATION_EXPIRED" };
  }
  return { enabled: true, reason: "AUTHORIZED_RELEASE_ATTESTATION_VERIFIED" };
}

function validateAttestation(value: unknown): asserts value is ReleaseAttestation {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid attestation object.");
  const item = value as Partial<ReleaseAttestation>;
  const requiredStrings = [
    item.licenseReference, item.independentAuditReference, item.complianceSignoffReference,
    item.dataProtectionReviewReference, item.approvedAt, item.licenseValidUntil
  ];
  if (
    item.schemaVersion !== 1 ||
    item.jurisdiction !== "RW" ||
    item.productScope !== "p2p_real_money" ||
    requiredStrings.some((entry) => typeof entry !== "string" || entry.trim().length === 0) ||
    !Array.isArray(item.paymentProviderApprovalReferences) ||
    item.paymentProviderApprovalReferences.length === 0 ||
    item.paymentProviderApprovalReferences.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    throw new TypeError("Required launch evidence is incomplete.");
  }
}
