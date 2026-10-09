/** Exact, non-negative quantities. Not a JSON wire/storage format (BigInt). */
export type Rational = Readonly<{ n: bigint; d: bigint }>;
export type Interval = Readonly<{ lo: Rational; hi: Rational }>;

// Bounds cap both input size and arithmetic growth, including repeated coprime fractions.
const ARITHMETIC_LIMIT = 10n ** 60n;
const INPUT_LIMIT = 10n ** 12n;
export const ZERO: Rational = Object.freeze({ n: 0n, d: 1n });
export const ONE: Rational = Object.freeze({ n: 1n, d: 1n });

export function rational(n: bigint, d = 1n): Rational {
  if (n < 0n || d <= 0n || n > ARITHMETIC_LIMIT || d > ARITHMETIC_LIMIT) {
    throw new RangeError('Inventory rational is negative, zero-denominator or too large');
  }
  let a = n;
  let b = d;
  while (b) [a, b] = [b, a % b];
  return Object.freeze({ n: n / a, d: d / a });
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}
export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}
export function multiply(a: Rational, b: Rational): Rational {
  // Cross-cancel before multiplication so exact, large intermediates need not overflow.
  const left = rational(a.n, b.d);
  const right = rational(b.n, a.d);
  return rational(left.n * right.n, left.d * right.d);
}
export function divide(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new RangeError('Inventory division by zero');
  return multiply(a, rational(b.d, b.n));
}
export function positiveDifference(a: Rational, b: Rational): Rational {
  return compare(a, b) <= 0 ? ZERO : rational(a.n * b.d - b.n * a.d, a.d * b.d);
}
export function interval(lo: Rational, hi = lo): Interval {
  // Validate even caller-constructed rationals at the public interval boundary.
  lo = rational(lo.n, lo.d);
  hi = rational(hi.n, hi.d);
  if (compare(lo, hi) > 0) throw new RangeError('Inventory interval is reversed');
  return Object.freeze({ lo, hi });
}
export function scale(value: Interval, factor: Rational): Interval {
  return interval(multiply(value.lo, factor), multiply(value.hi, factor));
}
export function sum(a: Interval, b: Interval): Interval {
  return interval(add(a.lo, b.lo), add(a.hi, b.hi));
}

/**
 * Group equal denominators before adding reduced groups in a fixed order. This both
 * cancels complementary fractions early and makes precision-limit rejection independent
 * of line/lot order. An irreducibly large composite denominator still throws RangeError.
 */
export function sumIntervals(values: readonly Interval[]): Interval {
  if (values.length > 1000) throw new RangeError('Too many inventory quantities');
  const validated = values.map(value => interval(value.lo, value.hi));
  const endpoint = (side: 'lo' | 'hi'): Rational => {
    const numerators = new Map<bigint, bigint>();
    for (const value of validated) {
      const { n, d } = value[side];
      numerators.set(d, (numerators.get(d) ?? 0n) + n);
    }
    const denominators = [...numerators.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    return denominators.reduce((total, d) => add(total, rational(numerators.get(d)!, d)), ZERO);
  };
  return interval(endpoint('lo'), endpoint('hi'));
}

/** Storage helpers deliberately widen both demand and supply, never round to nearest. */
export function outwardIntegers(value: Interval): Readonly<{ lo: bigint; hi: bigint }> {
  value = interval(value.lo, value.hi);
  return { lo: value.lo.n / value.lo.d, hi: (value.hi.n + value.hi.d - 1n) / value.hi.d };
}

const GLYPHS: Readonly<Record<string, readonly [bigint, bigint]>> = {
  '¼': [1n, 4n], '½': [1n, 2n], '¾': [3n, 4n], '⅐': [1n, 7n],
  '⅑': [1n, 9n], '⅒': [1n, 10n], '⅓': [1n, 3n], '⅔': [2n, 3n],
  '⅕': [1n, 5n], '⅖': [2n, 5n], '⅗': [3n, 5n], '⅘': [4n, 5n],
  '⅙': [1n, 6n], '⅚': [5n, 6n], '⅛': [1n, 8n], '⅜': [3n, 8n],
  '⅝': [5n, 8n], '⅞': [7n, 8n],
};
function parsePoint(text: string): Rational | null {
  const glyph = /^(?:(\d+)\s*)?([¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/u.exec(text);
  if (glyph) {
    const [n, d] = GLYPHS[glyph[2]];
    return add(rational(BigInt(glyph[1] ?? '0')), rational(n, d));
  }
  const fraction = /^(?:(\d+)\s+)?(\d+)\s*[\/⁄]\s*(\d+)$/u.exec(text);
  if (fraction) {
    const n = BigInt(fraction[2]);
    const d = BigInt(fraction[3]);
    if (n > INPUT_LIMIT || d > INPUT_LIMIT || d === 0n || (fraction[1] && n >= d)) return null;
    return add(rational(BigInt(fraction[1] ?? '0')), rational(n, d));
  }
  const decimal = /^(\d+)(?:\.(\d{1,12}))?$|^\.(\d{1,12})$/.exec(text);
  if (!decimal) return null;
  const digits = decimal[2] ?? decimal[3] ?? '';
  return rational(BigInt((decimal[1] ?? '0') + digits), 10n ** BigInt(digits.length));
}

export type QuantityParse = { ok: true; value: Interval } | {
  ok: false; reason: 'INVALID_QUANTITY' | 'QUANTITY_LIMIT';
};

/** Parses amounts only; never guesses units, names, packages or approximation tolerances. */
export function parseQuantity(text: string): QuantityParse {
  if (text.length > 64) return { ok: false, reason: 'QUANTITY_LIMIT' };
  const parts = text.trim().split(/\s*(?:[-–—]|\bto\b)\s*/iu);
  if (parts.length > 2) return { ok: false, reason: 'INVALID_QUANTITY' };
  try {
    const lo = parsePoint(parts[0]);
    const hi = parts.length === 2 ? parsePoint(parts[1]) : lo;
    if (!lo || !hi || compare(lo, hi) > 0) return { ok: false, reason: 'INVALID_QUANTITY' };
    if (compare(hi, rational(INPUT_LIMIT)) > 0) return { ok: false, reason: 'QUANTITY_LIMIT' };
    return { ok: true, value: interval(lo, hi) };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { ok: false, reason: 'QUANTITY_LIMIT' };
  }
}
