export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

export function money(amountMinor: bigint, currency: string): Money {
  if (amountMinor < 0n) throw new RangeError("Money amount cannot be negative.");
  if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError("Currency must be a three-letter uppercase ISO-style code.");
  return Object.freeze({ amountMinor, currency });
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.amountMinor + right.amountMinor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  if (right.amountMinor > left.amountMinor) throw new RangeError("Insufficient amount.");
  return money(left.amountMinor - right.amountMinor, left.currency);
}

export function parseMinorUnits(value: string, currency: string): Money {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError("Minor units must be an unsigned integer string.");
  return money(BigInt(value), currency);
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) throw new TypeError("Currency mismatch.");
}
