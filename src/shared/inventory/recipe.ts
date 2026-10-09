import { evaluateAvailability } from './availability';
import type { Calibration, Demand, InventoryItem, Lot } from './availability';
import { interval, outwardIntegers, rational } from './quantity';
import type { Interval, Rational } from './quantity';
import { parseQuantity } from './quantity';
import type { StockDimension } from './stock';
import type { AvailabilityItem, AvailabilityResult, InvCalibration, InvItem, InvLot, InvProfile, InvRange } from './wire';

/** The only form an item has: the item itself. Choosing a mapping is the human review of its form. */
const FORM = 'as-stocked';
const HOME_UNIT = { mass: 'mg', volume: 'ul' } as const;
const SCALE = { mass: 1_000_000n, volume: 1000n } as const;
const scaleOf = (dim: StockDimension): bigint => dim === 'mass' || dim === 'volume' ? SCALE[dim] : 1n;
const homeUnit = (dim: StockDimension): string => dim === 'mass' || dim === 'volume' ? HOME_UNIT[dim] : dim.slice(6);

/** Name used to match recipe ingredient names to reviewed mappings. */
export const ingredientKey = (name: string): string => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Recipe quantities arrive as JavaScript numbers. Recover the intended simple fraction (1/3, 3/4,
 * 1/8…) so exact stock is not compared with a rounded demand; otherwise round the demand UP so a
 * stray decimal can only make a recipe look more demanding, never less.
 */
export function exactRational(value: number): Rational {
  if (!Number.isFinite(value) || value < 0 || value > 100_000) throw new RangeError('Invalid recipe quantity');
  if (Number.isInteger(value)) return rational(BigInt(value));
  for (const denominator of [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 32, 50, 64, 100]) {
    const numerator = Math.round(value * denominator);
    if (numerator > 0 && Math.abs(value - numerator / denominator) < 1e-9) return rational(BigInt(numerator), BigInt(denominator));
  }
  return rational(BigInt(Math.ceil(value * 1e6)), 1_000_000n);
}

export type RecipeForCheck = Readonly<{ servings: number; ingredients: readonly Readonly<{ name: string; quantity: number | null; quantityMax?: number; unit: string }>[] }>;
type Names = ReadonlyMap<string, string>; // ingredientKey → itemId

/** True for stock past a use-by date. Dates are YYYY-MM-DD in the family timezone. */
export const isExpired = (lot: Pick<InvLot, 'dateKind' | 'date'>, today: string): boolean => lot.dateKind === 'use_by' && lot.date !== null && lot.date < today;

function lotAmount(lot: InvLot, dim: StockDimension): Interval {
  const scale = rational(scaleOf(dim));
  const qty = rational(BigInt(lot.qty));
  if (lot.precision === 'exact') return interval(rational(qty.n, scale.n), rational(qty.n, scale.n));
  const basis = BigInt(lot.estBp);
  const low = rational(qty.n * (10000n - basis), 10000n * scale.n);
  const high = rational(qty.n * (10000n + basis), 10000n * scale.n);
  return interval(low, high);
}

function range(value: Interval, dim: StockDimension): InvRange {
  const scale = scaleOf(dim);
  const bounds = outwardIntegers(interval(rational(value.lo.n * scale, value.lo.d), rational(value.hi.n * scale, value.hi.d)));
  const cap = BigInt(Number.MAX_SAFE_INTEGER);
  const clamp = (n: bigint) => Number(n > cap ? cap : n);
  return { lo: clamp(bounds.lo), hi: clamp(bounds.hi) };
}

/**
 * Checks one recipe against stock. Pure and server-side only: callers supply the recipe record
 * read from storage, never client text. Throws RangeError for inputs beyond the engine's bounds.
 */
export function checkRecipe(input: Readonly<{
  recipe: RecipeForCheck;
  servings: number;
  exclude: readonly number[];
  names: Names;
  items: readonly InvItem[];
  lots: readonly InvLot[];
  calibrations: readonly InvCalibration[];
  profile: InvProfile | null;
  /** Family-timezone calendar date; stock past its use-by date is excluded from supply. */
  today: string;
}>): AvailabilityResult {
  const byId = new Map(input.items.map(item => [item.id, item]));
  const excluded = new Set(input.exclude);
  const demands: Demand[] = [];
  const mappedItems = new Set<string>();
  const ozAssumed = new Set<string>();
  input.recipe.ingredients.forEach((ingredient, index) => {
    if (excluded.has(index)) { demands.push({ id: String(index), identity: null, amount: null, required: false }); return; }
    const itemId = input.names.get(ingredientKey(ingredient.name));
    const item = itemId ? byId.get(itemId) : undefined;
    if (!item) { demands.push({ id: String(index), identity: null, amount: null }); return; }
    mappedItems.add(item.id);
    let amount: Demand['amount'] = null;
    if (ingredient.quantity !== null) {
      const low = exactRational(ingredient.quantity);
      const high = ingredient.quantityMax === undefined ? low : exactRational(ingredient.quantityMax);
      // A bare count ("2 eggs") means the item's own count unit; every other unit must resolve on its own.
      let unit = ingredient.unit.trim() || (item.dim.startsWith('count:') ? item.dim.slice(6) : '');
      // The cook chose to track this item by weight, so a bare “oz” on it is a weight ounce. Other
      // items keep the ambiguity (a tracked-by-volume “oz” could be either) and stay unknown.
      if (item.dim === 'mass' && ['oz', 'ounce', 'ounces'].includes(unit.toLowerCase())) { unit = 'oz-mass'; ozAssumed.add(item.id); }
      amount = { quantity: interval(low, high), unit, ...(input.profile ? { profile: input.profile } : {}) };
    }
    demands.push({ id: String(index), identity: { itemId: item.id, form: FORM }, amount });
  });
  const items: InventoryItem[] = [...mappedItems].map(id => ({ identity: { itemId: id, form: FORM }, homeUnit: homeUnit(byId.get(id)!.dim) }));
  const expiredItems = new Set<string>();
  const lots: Lot[] = input.lots.filter(lot => mappedItems.has(lot.itemId)).map(lot => {
    const dim = byId.get(lot.itemId)!.dim;
    // A use-by date is a safety limit; a best-by date is only quality and stays in supply.
    const expired = isExpired(lot, input.today);
    if (expired) expiredItems.add(lot.itemId);
    return { id: lot.id, identity: { itemId: lot.itemId, form: FORM }, amount: { quantity: lotAmount(lot, dim), unit: homeUnit(dim) }, excluded: expired };
  });
  const calibrations: Calibration[] = input.calibrations.filter(c => mappedItems.has(c.itemId)).map(c => {
    const from = parseQuantity(c.fromAmount);
    const to = parseQuantity(c.toAmount);
    if (!from.ok || !to.ok) throw new RangeError('Stored calibration is invalid');
    return {
      id: c.id, identity: { itemId: c.itemId, form: FORM }, accepted: true,
      from: { quantity: from.value, unit: c.fromUnit, ...(c.fromProfile ? { profile: c.fromProfile } : {}) },
      to: { quantity: to.value, unit: c.toUnit, ...(c.toProfile ? { profile: c.toProfile } : {}) },
    };
  });
  const result = evaluateAvailability({ items, demands, lots, calibrations, recipeServings: input.recipe.servings, targetServings: input.servings });
  const rows: AvailabilityItem[] = result.items.map(row => {
    const item = byId.get(row.identity.itemId)!;
    return {
      itemId: item.id, itemName: item.name, dim: item.dim, lineIndexes: row.lineIds.map(Number), verdict: row.verdict,
      reasons: [...row.reasons, ...(expiredItems.has(item.id) ? ['EXPIRED_STOCK_EXCLUDED'] : []), ...(ozAssumed.has(item.id) ? ['OZ_ASSUMED_WEIGHT'] : [])], need: range(row.demand, item.dim), have: range(row.supply, item.dim),
      needComplete: row.demandComplete, haveComplete: row.supplyComplete,
      short: row.shortage ? range(row.shortage, item.dim) : null,
    };
  });
  return {
    verdict: result.verdict, servings: input.servings, recipeServings: input.recipe.servings, items: rows,
    unmapped: result.unresolved.map(line => ({ index: Number(line.lineId), name: input.recipe.ingredients[Number(line.lineId)].name })),
    excluded: result.excludedLineIds.map(Number),
  };
}
