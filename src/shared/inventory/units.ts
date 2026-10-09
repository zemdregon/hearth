import { divide, rational, scale } from './quantity';
import type { Interval, Rational } from './quantity';

export type MeasurementProfile = 'us-customary' | 'us-label' | 'metric-250';
export type Dimension = 'mass' | 'volume' | `count:${string}`;
export type Unit = Readonly<{ dimension: Dimension; factor: Rational }>;
export type UnitReason = 'UNKNOWN_UNIT' | 'MEASURE_PROFILE_AMBIGUOUS' | 'AMBIGUOUS_OUNCE';
export type UnitResult = { ok: true; unit: Unit } | { ok: false; reason: UnitReason };
export type Measurement = Readonly<{ quantity: Interval; unit: string; profile?: MeasurementProfile }>;

// Base units: mg, µL, and whole units of each named count (cloves are not heads).
// UCUM §§34,37,39: https://ucum.org/ucum. Derive US liquid units from 231 in³,
// inch = 2.54 cm, and avoirdupois lb = 7000 × 64.79891 mg; no rounded constants.
const MASS: Readonly<Record<string, Rational>> = {
  mg: rational(1n), g: rational(1000n), kg: rational(1000000n),
  'oz-mass': rational(45359237n, 1600n), lb: rational(45359237n, 100n),
};
const VOLUME: Readonly<Record<string, Rational>> = {
  ul: rational(1n), ml: rational(1000n), l: rational(1000000n),
};
const US_GALLON = rational(473176473n, 125n); // 3,785,411.784 µL
const US: Readonly<Record<string, Rational>> = {
  gallon: US_GALLON, quart: divide(US_GALLON, rational(4n)),
  pint: divide(US_GALLON, rational(8n)), cup: divide(US_GALLON, rational(16n)),
  'fl oz': divide(US_GALLON, rational(128n)), tbsp: divide(US_GALLON, rational(256n)),
  tsp: divide(US_GALLON, rational(768n)),
};
const LABEL: Readonly<Record<string, Rational>> = {
  tsp: rational(5000n), tbsp: rational(15000n), cup: rational(240000n), 'fl oz': rational(30000n),
};
// An explicit convention, not a claim that every metric country uses these spoons.
const METRIC: Readonly<Record<string, Rational>> = {
  tsp: rational(5000n), tbsp: rational(15000n), cup: rational(250000n),
};
// Can/package counts are intentionally unsupported until package size and net/drained
// basis are represented. An ingredient/form match alone cannot make cans interchangeable.
const COUNTS = new Set(['piece', 'egg', 'clove', 'head', 'bunch', 'slice', 'sprig']);
const ALIASES: Readonly<Record<string, string>> = {
  grams: 'g', gram: 'g', kilograms: 'kg', kilogram: 'kg', milligrams: 'mg', milligram: 'mg',
  milliliters: 'ml', millilitres: 'ml', milliliter: 'ml', millilitre: 'ml',
  liters: 'l', litres: 'l', liter: 'l', litre: 'l', 'µl': 'ul', 'μl': 'ul',
  pounds: 'lb', pound: 'lb', lbs: 'lb', 'avoirdupois ounce': 'oz-mass',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', floz: 'fl oz', 'fl. oz.': 'fl oz',
  teaspoons: 'tsp', teaspoon: 'tsp', tablespoons: 'tbsp', tablespoon: 'tbsp',
  cups: 'cup', pints: 'pint', pt: 'pint', quarts: 'quart', qt: 'quart', gallons: 'gallon', gal: 'gallon',
  each: 'piece', pieces: 'piece', eggs: 'egg', cloves: 'clove', heads: 'head',
  bunches: 'bunch', slices: 'slice', sprigs: 'sprig',
};

export function resolveUnit(text: string, profile?: MeasurementProfile): UnitResult {
  if (text.length > 50) return { ok: false, reason: 'UNKNOWN_UNIT' };
  const trimmed = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const key = Object.hasOwn(ALIASES, trimmed) ? ALIASES[trimmed] : trimmed;
  if (['oz', 'ounce', 'ounces'].includes(key)) return { ok: false, reason: 'AMBIGUOUS_OUNCE' };
  if (Object.hasOwn(MASS, key)) return { ok: true, unit: { dimension: 'mass', factor: MASS[key] } };
  if (Object.hasOwn(VOLUME, key)) return { ok: true, unit: { dimension: 'volume', factor: VOLUME[key] } };
  if (COUNTS.has(key)) return { ok: true, unit: { dimension: `count:${key}`, factor: rational(1n) } };
  if (Object.hasOwn(US, key)) {
    const table = profile === 'us-customary' ? US : profile === 'us-label' ? LABEL : profile === 'metric-250' ? METRIC : undefined;
    return table && Object.hasOwn(table, key)
      ? { ok: true, unit: { dimension: 'volume', factor: table[key] } }
      : { ok: false, reason: 'MEASURE_PROFILE_AMBIGUOUS' };
  }
  return { ok: false, reason: 'UNKNOWN_UNIT' };
}

export function convertSameDimension(value: Measurement, targetUnit: string, targetProfile?: MeasurementProfile):
  { ok: true; quantity: Interval } | { ok: false; reason: UnitReason | 'DIM_MISMATCH_NO_CONVERSION' } {
  const source = resolveUnit(value.unit, value.profile);
  const target = resolveUnit(targetUnit, targetProfile);
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (source.unit.dimension !== target.unit.dimension) return { ok: false, reason: 'DIM_MISMATCH_NO_CONVERSION' };
  return { ok: true, quantity: scale(value.quantity, divide(source.unit.factor, target.unit.factor)) };
}
