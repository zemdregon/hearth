import { compare, divide, interval, multiply, ONE, positiveDifference, rational, scale, sumIntervals, ZERO } from './quantity';
import type { Interval } from './quantity';
import { resolveUnit } from './units';
import type { Measurement, UnitReason } from './units';

/**
 * Reviewed catalog identity. Form must distinguish density/portion-relevant preparation
 * and size (packed vs sifted, whole vs chopped, large vs small); there is no default form.
 * Callers must withhold a mapping when these facts are unresolved, rather than normalize
 * incompatible variants to a shared form. This engine does not infer names or physical state.
 */
export type Identity = Readonly<{ itemId: string; form: string }>;
export type InventoryItem = Readonly<{ identity: Identity; homeUnit: string }>;
export type Demand = Readonly<{
  id: string;
  identity: Identity | null;
  amount: Measurement | null;
  /** False only after an explicit optional/exclusion decision by the caller. */
  required?: boolean;
}>;
export type Lot = Readonly<{
  id: string;
  identity: Identity;
  amount: Measurement | null;
  /** The caller resolves expiry, archival and eligibility policy before evaluation. */
  excluded?: boolean;
}>;
export type Calibration = Readonly<{
  id: string;
  identity: Identity;
  from: Measurement;
  to: Measurement;
  /** Must reflect a persisted human acceptance, never inferred from AI/reference data. */
  accepted: boolean;
}>;
export type Verdict = 'sufficient' | 'insufficient' | 'unknown';
export type Reason = UnitReason | 'NO_MATCH' | 'UNQUANTIFIED' | 'DIM_MISMATCH_NO_CONVERSION'
  | 'CALIBRATION_UNACCEPTED' | 'CALIBRATION_CONFLICT' | 'ACCEPTED_CALIBRATION'
  | 'RANGE_DEMAND' | 'ESTIMATED_STOCK' | 'INTERVAL_OVERLAP';

export type ItemAvailability = Readonly<{
  identity: Identity;
  unit: string;
  lineIds: readonly string[];
  verdict: Verdict;
  /** Known quantities only when *Complete is false; never interpret as the full amount. */
  demand: Interval;
  supply: Interval;
  demandComplete: boolean;
  supplyComplete: boolean;
  shortage: Interval | null;
  reasons: readonly Reason[];
}>;
export type Availability = Readonly<{
  verdict: Verdict;
  items: readonly ItemAvailability[];
  unresolved: readonly { lineId: string; reason: 'NO_MATCH' }[];
  excludedLineIds: readonly string[];
}>;

function identityKey(identity: Identity): string {
  for (const part of [identity.itemId, identity.form]) {
    if (typeof part !== 'string' || !part.trim() || part.length > 100) throw new RangeError('Invalid inventory identity');
  }
  // Exact, case-sensitive ids/forms; no fuzzy match, stripping or inferred substitutions.
  return JSON.stringify([identity.itemId, identity.form]);
}

type Conversion = { ok: true; quantity: Interval; calibrated: boolean } | { ok: false; reason: Reason };

/** A single accepted calibration may bridge dimensions or semantic counts; no chained guesses. */
export function convertForItem(item: InventoryItem, amount: Measurement, calibrations: readonly Calibration[] = []): Conversion {
  if (calibrations.length > 200) throw new RangeError('Too many inventory calibrations');
  const key = identityKey(item.identity);
  const source = resolveUnit(amount.unit, amount.profile);
  const target = resolveUnit(item.homeUnit);
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (source.unit.dimension === target.unit.dimension) {
    return { ok: true, quantity: scale(amount.quantity, divide(source.unit.factor, target.unit.factor)), calibrated: false };
  }
  const candidates: Interval[] = [];
  let unaccepted = false;
  for (const calibration of calibrations) {
    if (identityKey(calibration.identity) !== key) continue;
    const from = resolveUnit(calibration.from.unit, calibration.from.profile);
    const to = resolveUnit(calibration.to.unit, calibration.to.profile);
    if (!from.ok || !to.ok) continue;
    const forward = from.unit.dimension === source.unit.dimension && to.unit.dimension === target.unit.dimension;
    const reverse = to.unit.dimension === source.unit.dimension && from.unit.dimension === target.unit.dimension;
    if (!forward && !reverse) continue;
    if (!calibration.accepted) { unaccepted = true; continue; }
    const fromBase = scale(calibration.from.quantity, from.unit.factor);
    const toBase = scale(calibration.to.quantity, to.unit.factor);
    if (compare(fromBase.lo, ZERO) <= 0 || compare(toBase.lo, ZERO) <= 0) {
      throw new RangeError('Calibration quantities must be positive');
    }
    const numerator = forward ? toBase : fromBase;
    const denominator = forward ? fromBase : toBase;
    candidates.push(interval(divide(numerator.lo, denominator.hi), divide(numerator.hi, denominator.lo)));
  }
  if (candidates.length > 1) return { ok: false, reason: 'CALIBRATION_CONFLICT' };
  if (!candidates.length) return { ok: false, reason: unaccepted ? 'CALIBRATION_UNACCEPTED' : 'DIM_MISMATCH_NO_CONVERSION' };
  const baseAmount = scale(amount.quantity, source.unit.factor);
  const ratio = candidates[0];
  return {
    ok: true,
    quantity: interval(
      divide(multiply(baseAmount.lo, ratio.lo), target.unit.factor),
      divide(multiply(baseAmount.hi, ratio.hi), target.unit.factor),
    ),
    calibrated: true,
  };
}

/** Exact comparisons prevent a matching fractional quantity becoming a rounded shortage. */
export function compareAvailability(demand: Interval, supply: Interval): Verdict {
  demand = interval(demand.lo, demand.hi);
  supply = interval(supply.lo, supply.hi);
  if (compare(demand.hi, supply.lo) <= 0) return 'sufficient';
  if (compare(demand.lo, supply.hi) > 0) return 'insufficient';
  return 'unknown';
}

function validateIds(values: readonly { id: string }[], limit: number): void {
  if (values.length > limit) throw new RangeError('Inventory input limit exceeded');
  const seen = new Set<string>();
  for (const { id } of values) {
    if (!id || id.length > 100 || seen.has(id)) throw new RangeError('Invalid or duplicate inventory input id');
    seen.add(id);
  }
}

/**
 * Stage 0 domain API, not an HTTP validator. Caller supplies explicit reviewed identity/form
 * mappings, a complete eligible inventory snapshot and parsed quantities. Invalid bounded
 * inputs or excessive composite precision throw RangeError; legitimate incomplete knowledge
 * produces an unknown verdict. Arithmetic acceptance does not imply storage-safe quantities:
 * a future persistence boundary must separately enforce its base-unit quantity/size limits.
 */
export function evaluateAvailability(input: Readonly<{
  items: readonly InventoryItem[];
  demands: readonly Demand[];
  lots: readonly Lot[];
  calibrations?: readonly Calibration[];
  recipeServings?: number;
  targetServings?: number;
}>): Availability {
  if (input.items.length > 200) throw new RangeError('Too many inventory items');
  validateIds(input.demands, 100);
  validateIds(input.lots, 1000);
  const calibrations = input.calibrations ?? [];
  validateIds(calibrations, 200);
  const recipeServings = input.recipeServings ?? 1;
  const targetServings = input.targetServings ?? recipeServings;
  for (const servings of [recipeServings, targetServings]) {
    if (!Number.isInteger(servings) || servings < 1 || servings > 1000) throw new RangeError('Invalid inventory servings');
  }
  const factor = divide(rational(BigInt(targetServings)), rational(BigInt(recipeServings)));
  const catalog = new Map<string, InventoryItem>();
  for (const item of input.items) {
    const key = identityKey(item.identity);
    if (catalog.has(key) || !resolveUnit(item.homeUnit).ok) throw new RangeError('Duplicate identity or unresolved home unit');
    catalog.set(key, item);
  }
  const groups = new Map<string, Demand[]>();
  const unresolved: { lineId: string; reason: 'NO_MATCH' }[] = [];
  const excludedLineIds: string[] = [];
  for (const demand of input.demands) {
    if (demand.required === false) { excludedLineIds.push(demand.id); continue; }
    const key = demand.identity && identityKey(demand.identity);
    if (!key || !catalog.has(key)) { unresolved.push({ lineId: demand.id, reason: 'NO_MATCH' }); continue; }
    const lines = groups.get(key) ?? [];
    lines.push(demand);
    groups.set(key, lines);
  }
  const stock = new Map<string, Lot[]>();
  for (const lot of input.lots) {
    const key = identityKey(lot.identity);
    if (lot.excluded) continue;
    const lots = stock.get(key) ?? [];
    lots.push(lot);
    stock.set(key, lots);
  }
  const items: ItemAvailability[] = [];
  for (const [key, lines] of groups) {
    const item = catalog.get(key)!;
    const demandParts: Interval[] = [];
    const supplyParts: Interval[] = [];
    let demandComplete = true;
    let supplyComplete = true;
    const reasons = new Set<Reason>();
    for (const [isDemand, entries] of [[true, lines], [false, stock.get(key) ?? []]] as const) {
      for (const entry of entries) {
        const converted: Conversion = entry.amount
          ? convertForItem(item, entry.amount, calibrations)
          : { ok: false, reason: 'UNQUANTIFIED' };
        if (!converted.ok) {
          reasons.add(converted.reason);
          if (isDemand) demandComplete = false;
          else supplyComplete = false;
          continue;
        }
        const quantity = scale(converted.quantity, isDemand ? factor : ONE);
        if (converted.calibrated) reasons.add('ACCEPTED_CALIBRATION');
        if (compare(quantity.lo, quantity.hi) !== 0) reasons.add(isDemand ? 'RANGE_DEMAND' : 'ESTIMATED_STOCK');
        if (isDemand) demandParts.push(quantity);
        else supplyParts.push(quantity);
      }
    }
    const demand = sumIntervals(demandParts);
    const supply = sumIntervals(supplyParts);
    // Unknown demand can only add demand; unknown stock can only add stock.
    // Keep a proven shortage from known demand, or sufficiency from known stock.
    const verdict: Verdict = supplyComplete && compare(demand.lo, supply.hi) > 0 ? 'insufficient'
      : demandComplete && compare(demand.hi, supply.lo) <= 0 ? 'sufficient' : 'unknown';
    if (verdict === 'unknown' && demandComplete && supplyComplete) reasons.add('INTERVAL_OVERLAP');
    items.push({
      identity: item.identity, unit: item.homeUnit, lineIds: lines.map(line => line.id), verdict,
      demand, supply, demandComplete, supplyComplete, reasons: [...reasons],
      shortage: demandComplete && supplyComplete ? interval(
        positiveDifference(demand.lo, supply.hi), positiveDifference(demand.hi, supply.lo),
      ) : null,
    });
  }
  return {
    verdict: items.some(item => item.verdict === 'insufficient') ? 'insufficient'
      : unresolved.length || items.some(item => item.verdict === 'unknown') ? 'unknown' : 'sufficient',
    items, unresolved, excludedLineIds,
  };
}
