import { describe, expect, it } from 'vitest';
import {
  add, compare, compareAvailability, convertForItem, convertSameDimension, divide,
  evaluateAvailability, interval, multiply, outwardIntegers, parseQuantity, rational, resolveUnit, sumIntervals,
} from '../src/shared/inventory';
import type { Calibration, Demand, Identity, InventoryItem, Interval, Lot, Measurement, MeasurementProfile } from '../src/shared/inventory';

function q(text: string): Interval {
  const parsed = parseQuantity(text);
  if (!parsed.ok) throw new Error(`Fixture quantity failed: ${text}`);
  return parsed.value;
}
function amount(text: string, unit: string, profile?: MeasurementProfile): Measurement {
  return { quantity: q(text), unit, profile };
}
const flour: Identity = { itemId: 'flour-ap', form: 'unsifted' };
const flourItem: InventoryItem = { identity: flour, homeUnit: 'g' };
function demand(id: string, text: string, unit = 'g', identity = flour): Demand {
  return { id, identity, amount: amount(text, unit) };
}
function lot(id: string, text: string, unit = 'g', identity = flour): Lot {
  return { id, identity, amount: amount(text, unit) };
}
function check(demands: Demand[], lots: Lot[], extra: Partial<Parameters<typeof evaluateAvailability>[0]> = {}) {
  return evaluateAvailability({ items: [flourItem], demands, lots, ...extra });
}
const cupCalibration: Calibration = {
  id: 'cup-weighed', identity: flour, accepted: true,
  from: amount('1', 'cup', 'metric-250'), to: amount('120-130', 'g'),
};

describe('bounded exact inventory quantities', () => {
  it.each([
    ['1/3', 1n, 3n], ['⅓', 1n, 3n], ['1½', 3n, 2n], ['1 ½', 3n, 2n],
    ['2 3/4', 11n, 4n], ['2 3⁄4', 11n, 4n], ['.125', 1n, 8n], ['0.333', 333n, 1000n],
    ['0', 0n, 1n], ['1000000000000', 1000000000000n, 1n], ['0.000000000001', 1n, 1000000000000n],
  ])('parses %s without floating-point approximation', (text, n, d) => {
    expect(q(text)).toEqual(interval(rational(n, d)));
  });
  it.each(['1-2', '1 – 2', '1 to 2', '1—2'])('retains both range endpoints: %s', text => {
    expect(q(text)).toEqual(interval(rational(1n), rational(2n)));
  });
  it('parses ranges of mixed numbers and glyphs', () => {
    expect(q('1½ to 2 3/4')).toEqual(interval(rational(3n, 2n), rational(11n, 4n)));
  });
  it.each(['', '-1', '+1', 'NaN', 'Infinity', '1e3', '1,000', '1/0', '2-1', '1-2-3', '1 3/2', 'about 2', 'to taste', '1 cup', '1.1234567890123'])('rejects invalid quantity %s', text => {
    expect(parseQuantity(text).ok).toBe(false);
  });
  it('bounds parsing and arithmetic work', () => {
    expect(parseQuantity('1'.repeat(65))).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
    expect(parseQuantity('1000000000001')).toEqual({ ok: false, reason: 'QUANTITY_LIMIT' });
    expect(parseQuantity('1/1000000000001').ok).toBe(false);
    expect(() => rational(-1n)).toThrow(RangeError);
    expect(() => rational(1n, 0n)).toThrow(RangeError);
    expect(() => rational(10n ** 61n)).toThrow(RangeError);
    expect(() => multiply(rational(10n ** 40n), rational(10n ** 40n))).toThrow(RangeError);
    expect(() => divide(rational(1n), rational(0n))).toThrow(RangeError);
    expect(() => interval(rational(2n), rational(1n))).toThrow(RangeError);
  });
  it('adds thirds exactly and keeps entered decimal distinct', () => {
    const third = q('⅓').lo;
    expect(add(add(third, third), third)).toEqual(rational(1n));
    expect(compare(q('0.333').lo, third)).toBe(-1);
  });
  it('rejects irreducibly excessive precision in any input order', () => {
    const denominators = [999999999989n, 999999999979n, 999999999961n, 999999999959n, 999999999953n, 999999999929n];
    const values = denominators.map(d => interval(rational(1n, d)));
    expect(() => sumIntervals(values)).toThrow(RangeError);
    expect(() => sumIntervals([...values].reverse())).toThrow(RangeError);
  });
  it('outward rounding contains the exact quantity at both ends', () => {
    expect(outwardIntegers(q('28349.523125'))).toEqual({ lo: 28349n, hi: 28350n });
    expect(outwardIntegers(q('0'))).toEqual({ lo: 0n, hi: 0n });
    for (let denominator = 2n; denominator <= 37n; denominator++) {
      const exact = rational(101n, denominator);
      const bounds = outwardIntegers(interval(exact));
      expect(compare(rational(bounds.lo), exact)).toBeLessThanOrEqual(0);
      expect(compare(rational(bounds.hi), exact)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('explicit measurement conventions', () => {
  it.each([
    ['lb', 'mg', '453592.37'], ['oz-mass', 'mg', '28349.523125'], ['kg', 'g', '1000'],
    ['l', 'ml', '1000'], ['ml', 'ul', '1000'],
  ])('converts one %s to %s exactly', (source, target, expected) => {
    expect(convertSameDimension(amount('1', source), target)).toEqual({ ok: true, quantity: q(expected) });
  });
  it.each([
    ['gallon', '3785.411784'], ['quart', '946.352946'], ['pint', '473.176473'],
    ['cup', '236.5882365'], ['fl oz', '29.5735295625'], ['tbsp', '14.78676478125'], ['tsp', '4.92892159375'],
  ])('uses full US customary definition for %s', (unit, expected) => {
    expect(convertSameDimension(amount('1', unit, 'us-customary'), 'ml')).toEqual({ ok: true, quantity: q(expected) });
  });
  it('requires explicit profiles and separates customary, label and metric cups', () => {
    expect(resolveUnit('cup')).toEqual({ ok: false, reason: 'MEASURE_PROFILE_AMBIGUOUS' });
    expect(convertSameDimension(amount('1', 'cup', 'us-label'), 'ml')).toEqual({ ok: true, quantity: q('240') });
    expect(convertSameDimension(amount('1', 'cup', 'metric-250'), 'ml')).toEqual({ ok: true, quantity: q('250') });
    expect(convertSameDimension(amount('1', 'cup', 'us-label'), 'cup', 'metric-250')).toEqual({ ok: true, quantity: q('.96') });
    expect(resolveUnit('pint', 'metric-250').ok).toBe(false);
    expect(resolveUnit('pint', 'us-label').ok).toBe(false);
    expect(resolveUnit('fl oz', 'metric-250').ok).toBe(false);
  });
  it('does not treat ambiguous ounces, pinches, absent units or unknown tokens as a conversion', () => {
    expect(resolveUnit('oz')).toEqual({ ok: false, reason: 'AMBIGUOUS_OUNCE' });
    for (const unit of ['', 'pinch', 'handful', 'can', 'cans', 'package', 'packages', 'constructor', '__proto__', 'x'.repeat(51)]) {
      expect(resolveUnit(unit)).toEqual({ ok: false, reason: 'UNKNOWN_UNIT' });
    }
    expect(convertSameDimension(amount('1', 'g'), 'ml')).toEqual({ ok: false, reason: 'DIM_MISMATCH_NO_CONVERSION' });
  });
  it('preserves count semantics and only accepts explicit harmless aliases', () => {
    expect(convertSameDimension(amount('3', 'cloves'), 'clove')).toEqual({ ok: true, quantity: q('3') });
    expect(convertSameDimension(amount('1', 'head'), 'clove')).toEqual({ ok: false, reason: 'DIM_MISMATCH_NO_CONVERSION' });
    expect(convertSameDimension(amount('1', 'egg'), 'piece')).toEqual({ ok: false, reason: 'DIM_MISMATCH_NO_CONVERSION' });
    expect(resolveUnit(' Grams ')).toEqual(resolveUnit('g'));
  });
  it('round-trips representative same-dimension values exactly', () => {
    for (let n = 1; n <= 30; n++) {
      const original = amount(`${n}/37`, 'lb');
      const converted = convertSameDimension(original, 'kg');
      expect(converted.ok).toBe(true);
      if (!converted.ok) continue;
      expect(convertSameDimension({ quantity: converted.quantity, unit: 'kg' }, 'lb')).toEqual({ ok: true, quantity: original.quantity });
    }
  });
});

describe('ingredient-specific accepted calibration', () => {
  it('requires a matching ingredient, exact form and human-accepted evidence', () => {
    const value = amount('1', 'cup', 'metric-250');
    expect(convertForItem(flourItem, value)).toMatchObject({ ok: false, reason: 'DIM_MISMATCH_NO_CONVERSION' });
    expect(convertForItem(flourItem, value, [{ ...cupCalibration, accepted: false }])).toMatchObject({ ok: false, reason: 'CALIBRATION_UNACCEPTED' });
    expect(convertForItem(flourItem, value, [{ ...cupCalibration, identity: { ...flour, form: 'sifted' } }]).ok).toBe(false);
    expect(convertForItem(flourItem, value, [{ ...cupCalibration, identity: { ...flour, itemId: 'sugar' } }]).ok).toBe(false);
    expect(convertForItem(flourItem, value, [cupCalibration])).toEqual({ ok: true, quantity: q('120-130'), calibrated: true });
  });
  it('scales the actual volume when the recipe and calibration use different cups', () => {
    const calibration = { ...cupCalibration, to: amount('125', 'g') };
    expect(convertForItem(flourItem, amount('1', 'cup', 'us-label'), [calibration])).toEqual({ ok: true, quantity: q('120'), calibrated: true });
    expect(convertForItem(flourItem, amount('1', 'cup'), [calibration])).toMatchObject({ ok: false, reason: 'MEASURE_PROFILE_AMBIGUOUS' });
  });
  it('inverts an uncertain calibration conservatively', () => {
    const converted = convertForItem({ ...flourItem, homeUnit: 'ml' }, amount('130', 'g'), [cupCalibration]);
    expect(converted).toEqual({ ok: true, quantity: interval(rational(250n), rational(1625n, 6n)), calibrated: true });
  });
  it('requires a selected calibration instead of arbitrarily taking the first', () => {
    expect(convertForItem(flourItem, amount('1', 'ml'), [cupCalibration, { ...cupCalibration, id: 'other' }])).toMatchObject({ ok: false, reason: 'CALIBRATION_CONFLICT' });
    expect(() => convertForItem(flourItem, amount('1', 'ml'), [{ ...cupCalibration, from: amount('0-1', 'ml') }])).toThrow(RangeError);
  });
  it('allows explicitly calibrated count subdivisions, never universal head-to-clove constants', () => {
    const garlic = { itemId: 'garlic', form: 'whole' };
    const item = { identity: garlic, homeUnit: 'clove' };
    const calibration = { id: 'garlic-head', identity: garlic, accepted: true, from: amount('1', 'head'), to: amount('8-12', 'clove') };
    expect(convertForItem(item, amount('2', 'head'), [calibration])).toEqual({ ok: true, quantity: q('16-24'), calibrated: true });
  });
});

describe('aggregate recipe availability', () => {
  it('aggregates repeated demand before comparing the same stock', () => {
    const result = check([demand('batter', '150'), demand('dusting', '150')], [lot('bag', '200')]);
    expect(result.verdict).toBe('insufficient');
    expect(result.items[0]).toMatchObject({ demand: q('300'), supply: q('200'), shortage: q('100'), lineIds: ['batter', 'dusting'] });
  });
  it('aggregates complementary fractions identically regardless of demand/lot ordering', () => {
    const denominators = [999999999989n, 999999999979n, 999999999961n, 999999999959n, 999999999953n, 999999999929n];
    const fractions = denominators.map(d => `1/${d}`);
    const complements = denominators.map(d => `${d - 1n}/${d}`);
    const orders = [
      [...fractions, ...complements],
      fractions.flatMap((value, i) => [value, complements[i]]),
      [...complements, ...fractions].reverse(),
    ];
    for (const order of orders) {
      const demands = order.map((value, i) => demand(`d${i}`, value, 'mg'));
      const lots = [...order].reverse().map((value, i) => lot(`l${i}`, value, 'mg'));
      const result = check(demands, lots, { items: [{ ...flourItem, homeUnit: 'mg' }] });
      expect(result.verdict).toBe('sufficient');
      expect(result.items[0]).toMatchObject({ demand: q('6'), supply: q('6') });
    }
  });
  it('scales servings exactly, including ranges and repeated thirds', () => {
    const result = check([demand('a', '1/3'), demand('b', '1/3'), demand('c', '1/3')], [lot('bag', '3/2')], { recipeServings: 4, targetServings: 6 });
    expect(result.verdict).toBe('sufficient');
    expect(result.items[0].demand).toEqual(q('3/2'));
    expect(check([demand('a', '1-2')], [lot('bag', '3')], { recipeServings: 2, targetServings: 3 }).items[0].demand).toEqual(q('1.5-3'));
  });
  it('keeps exact equality sufficient across non-integer conversion factors', () => {
    const result = check([demand('a', '1', 'oz-mass')], [lot('bag', '1/16', 'lb')]);
    expect(result.verdict).toBe('sufficient');
    expect(result.items[0].shortage).toEqual(q('0'));
    expect(compareAvailability(q('28349.523125'), q('28349.523125'))).toBe('sufficient');
    expect(compareAvailability(q('28349-28350'), q('28349-28350'))).toBe('unknown');
  });
  it('handles ranges without replacing them by an average', () => {
    expect(check([demand('a', '100-120')], [lot('bag', '120')]).verdict).toBe('sufficient');
    expect(check([demand('a', '100-120')], [lot('bag', '99')]).verdict).toBe('insufficient');
    const result = check([demand('a', '100-120')], [lot('bag', '110')]);
    expect(result.verdict).toBe('unknown');
    expect(result.items[0].shortage).toEqual(q('0-10'));
    expect(result.items[0].reasons).toContain('INTERVAL_OVERLAP');
    expect(check([demand('a', '100')], [lot('bag', '90-110')]).verdict).toBe('unknown');
  });
  it('does not silently match case, forms, names or similar ingredient ids', () => {
    expect(check([demand('a', '10', 'g', { ...flour, itemId: 'flour-ap-other' })], [lot('bag', '100')]).verdict).toBe('unknown');
    expect(check([demand('a', '10', 'g', { ...flour, form: 'UNSIFTED' })], [lot('bag', '100')]).unresolved).toEqual([{ lineId: 'a', reason: 'NO_MATCH' }]);
    expect(check([demand('a', '10')], [lot('bag', '100', 'g', { ...flour, form: 'sifted' })]).verdict).toBe('insufficient');
  });
  it('keeps required unquantified and unconvertible amounts unknown', () => {
    expect(check([{ id: 'taste', identity: flour, amount: null }], [lot('bag', '100')]).verdict).toBe('unknown');
    expect(check([demand('a', '1', 'cup')], [lot('bag', '100')]).items[0].reasons).toContain('MEASURE_PROFILE_AMBIGUOUS');
    expect(check([demand('a', '1', 'ml')], [lot('bag', '100')]).items[0].reasons).toContain('DIM_MISMATCH_NO_CONVERSION');
    expect(check([demand('a', '1')], [lot('bag', '1', 'ml')]).verdict).toBe('unknown');
    // Matching identity/form cannot resolve whether two cans have the same size/basis.
    expect(check([demand('a', '1', 'can')], [lot('bag', '2', 'can')]).verdict).toBe('unknown');
  });
  it('proves known shortage despite additional unknown demand, but never ignores unknown supply', () => {
    const demands = [demand('a', '101'), { id: 'taste', identity: flour, amount: null }];
    const result = check(demands, [lot('bag', '100')]);
    expect(result.verdict).toBe('insufficient');
    expect(result.items[0]).toMatchObject({ demandComplete: false, shortage: null });
    expect(check(demands, [lot('bag', '100'), { id: 'mystery', identity: flour, amount: null }]).verdict).toBe('unknown');
  });
  it('proves known sufficiency even with extra unquantified stock', () => {
    const result = check([demand('a', '100')], [lot('bag', '100'), { id: 'mystery', identity: flour, amount: null }]);
    expect(result.verdict).toBe('sufficient');
    expect(result.items[0]).toMatchObject({ supplyComplete: false, shortage: null });
  });
  it('does not let an unmatched required line disappear, and shortage outranks unknown', () => {
    const unmatched: Demand = { id: 'mystery', identity: null, amount: null };
    expect(check([unmatched], []).verdict).toBe('unknown');
    expect(check([demand('a', '1'), unmatched], []).verdict).toBe('insufficient');
    expect(check([demand('a', '1'), { ...unmatched, required: false }], [lot('bag', '1')])).toMatchObject({ verdict: 'sufficient', excludedLineIds: ['mystery'] });
  });
  it('excludes only explicitly ineligible lots and does not double-count duplicate ids', () => {
    expect(check([demand('a', '10')], [{ ...lot('bag', '100'), excluded: true }]).verdict).toBe('insufficient');
    expect(() => check([demand('a', '10')], [lot('bag', '100'), lot('bag', '100')])).toThrow(RangeError);
    expect(() => check([demand('a', '10'), demand('a', '10')], [])).toThrow(RangeError);
    expect(() => check([], [], { items: [flourItem, flourItem] })).toThrow(RangeError);
  });
  it('uses accepted calibration intervals without overstating enough stock', () => {
    const needsCup: Demand = { id: 'cup', identity: flour, amount: amount('1', 'cup', 'metric-250') };
    expect(check([needsCup], [lot('bag', '125')], { calibrations: [cupCalibration] }).verdict).toBe('unknown');
    const sufficient = check([needsCup], [lot('bag', '130')], { calibrations: [cupCalibration] });
    expect(sufficient.verdict).toBe('sufficient');
    expect(sufficient.items[0].reasons).toContain('ACCEPTED_CALIBRATION');
    expect(check([needsCup], [lot('bag', '1000')], { calibrations: [{ ...cupCalibration, accepted: false }] }).verdict).toBe('unknown');
  });
  it('rejects excessive workload, invalid servings and bounded arithmetic exhaustion', () => {
    for (const targetServings of [0, -1, .5, 1001, Infinity, NaN]) {
      expect(() => check([], [], { targetServings })).toThrow(RangeError);
    }
    expect(() => check(Array.from({ length: 101 }, (_, i) => demand(String(i), '1')), [])).toThrow(RangeError);
    const huge = interval(rational(10n ** 60n));
    expect(() => check([{ id: 'a', identity: flour, amount: { quantity: huge, unit: 'kg' } }], [])).toThrow(RangeError);
  });
  it('sufficiency remains true with additional exact stock, and shortage with additional demand', () => {
    for (let n = 1; n <= 25; n++) {
      const value = `${n}/37`;
      expect(check([demand('a', value)], [lot('bag', value), lot('extra', '1/13')]).verdict).toBe('sufficient');
      expect(check([demand('a', value), demand('extra', '1/13')], [lot('bag', value)]).verdict).toBe('insufficient');
    }
  });
});
