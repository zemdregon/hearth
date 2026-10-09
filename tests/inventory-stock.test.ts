import { describe, expect, it } from 'vitest';
import { formatStock, MAX_STOCK, stockQuantity } from '../src/shared/inventory';

const qty = (amount: string, unit: string, dim: Parameters<typeof stockQuantity>[1], extra: Partial<Parameters<typeof stockQuantity>[0]> = {}, options = {}) => stockQuantity({ amount, unit, ...extra }, dim, options);

describe('stock entry', () => {
  it('is exact for weights and counts, and within half a base unit for US volumes', () => {
    expect(qty('1', 'lb', 'mass')).toMatchObject({ ok: true, qty: 453_592_370_000 });
    expect(qty('1', 'oz-mass', 'mass')).toMatchObject({ ok: true, qty: 28_349_523_125 });
    expect(qty('0.25', 'kg', 'mass')).toMatchObject({ ok: true, qty: 250_000_000_000 });
    expect(qty('1', 'cup', 'volume', { profile: 'us-customary' })).toMatchObject({ ok: true, qty: 236_588_237 });
    expect(qty('1', 'fl oz', 'volume', { profile: 'us-customary' })).toMatchObject({ ok: true, qty: 29_573_530 });
    expect(qty('1 1/2', 'egg', 'count:egg')).toMatchObject({ ok: false });
    expect(qty('6', 'eggs', 'count:egg')).toMatchObject({ ok: true, qty: 6 });
  });
  it('rounds up to the next base unit and refuses ambiguity, mismatch, ranges and zero', () => {
    expect(qty('1', 'tsp', 'volume', { profile: 'us-customary' })).toMatchObject({ ok: true, qty: 4_928_922 });
    expect(qty('2', 'tsp', 'volume', { profile: 'us-customary' })).toMatchObject({ ok: true, qty: 9_857_844 }); // 9,857,843.1875 rounds up, never down
    expect(qty('1/3', 'cup', 'volume', { profile: 'us-customary' })).toMatchObject({ ok: true, qty: 78_862_746 });
    expect(qty('1', 'cup', 'volume')).toMatchObject({ ok: false });
    expect(qty('1', 'oz', 'mass')).toMatchObject({ ok: false });
    expect(qty('1', 'g', 'volume')).toMatchObject({ ok: false });
    expect(qty('2-3', 'g', 'mass')).toMatchObject({ ok: false });
    expect(qty('0', 'g', 'mass')).toMatchObject({ ok: false });
    expect(qty('0', 'g', 'mass', {}, { allowZero: true })).toMatchObject({ ok: true, qty: 0 });
  });
  it('enforces the JS-safe upper bound at the boundary', () => {
    expect(qty('9000', 'kg', 'mass')).toMatchObject({ ok: true, qty: MAX_STOCK });
    expect(qty('9000.000001', 'kg', 'mass')).toMatchObject({ ok: false });
    expect(Number.isSafeInteger(MAX_STOCK)).toBe(true);
  });
  it('formats for display without changing storage', () => {
    expect(formatStock(1_500_000_000_000, 'mass')).toBe('1.5 kg');
    expect(formatStock(680_388_555_000, 'mass')).toBe('680.389 g');
    expect(formatStock(473_176_473, 'volume')).toBe('473.176 mL');
    expect(formatStock(0, 'mass')).toBe('0 g');
    expect(formatStock(0, 'volume')).toBe('0 mL');
    expect(formatStock(2, 'count:bunch')).toBe('2 bunches');
    expect(formatStock(1, 'count:egg')).toBe('1 egg');
    expect(formatStock(12, 'count:egg')).toBe('12 eggs');
  });
});
