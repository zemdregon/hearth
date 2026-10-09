import { compare, multiply, parseQuantity, ZERO } from './quantity';
import { resolveUnit } from './units';
import type { MeasurementProfile } from './units';

/**
 * Stored stock is an integer in ng (mass), nL (volume) or whole counts of one named semantic
 * unit. Those are 10^6 and 10^3 times the engine's mg / µL bases, so every pound, ounce, gram and
 * millilitre is exact. Some US-customary volumes (a cup is 236,588,236.5 nL, a teaspoon is not a
 * finite decimal) are not whole nanolitres: those round UP to the next base unit. A stored lot is
 * therefore the entered amount plus less than one base unit (under 1 nL / 1 ng, far below any
 * household measurement), which keeps "I have exactly what the recipe needs" sufficient instead
 * of a spurious sub-nanolitre shortage.
 */
export const stockDimensions = ['mass', 'volume', 'count:piece', 'count:egg', 'count:clove', 'count:head', 'count:bunch', 'count:slice', 'count:sprig'] as const;
export type StockDimension = typeof stockDimensions[number];
export const MAX_STOCK = 9_000_000_000_000_000; // below Number.MAX_SAFE_INTEGER
const SCALE = { mass: 1_000_000n, volume: 1000n } as const;
export const measurementProfiles = ['us-customary', 'us-label', 'metric-250'] as const satisfies readonly MeasurementProfile[];

export type StockEntry = Readonly<{ amount: string; unit: string; profile?: MeasurementProfile }>;
export type StockResult = { ok: true; qty: number; text: string } | { ok: false; message: string };

const REASONS: Readonly<Record<string, string>> = {
  UNKNOWN_UNIT: 'This unit is not recognised. Use g, kg, oz (weight), mL, L, cups, tsp, or a count such as egg or clove.',
  MEASURE_PROFILE_AMBIGUOUS: 'Cups, spoons and fluid ounces differ by region. Choose a measuring convention first.',
  AMBIGUOUS_OUNCE: 'Say whether “oz” means weight (avoirdupois ounce) or fluid ounces; use “fl oz” for liquids.',
};

/**
 * Converts one exact, positive entry into integer base units for an item's dimension.
 * Rounds only up to the next base unit (see above); ranges, zero, mismatched dimensions and
 * unresolved unit conventions are explicit errors.
 */
export function stockQuantity(entry: StockEntry, dimension: StockDimension, options: { allowZero?: boolean } = {}): StockResult {
  const parsed = parseQuantity(entry.amount);
  if (!parsed.ok) return { ok: false, message: parsed.reason === 'QUANTITY_LIMIT' ? 'That amount is too large.' : 'Enter one exact amount such as 2, 1/2 or 1.5.' };
  if (compare(parsed.value.lo, parsed.value.hi) !== 0) return { ok: false, message: 'Enter one amount, not a range. For a rough amount, type your best single guess (like 1.5) and tick “It’s an estimate”.' };
  if (!options.allowZero && compare(parsed.value.lo, ZERO) === 0) return { ok: false, message: 'Enter an amount greater than zero.' };
  const unit = resolveUnit(entry.unit, entry.profile);
  if (!unit.ok) return { ok: false, message: REASONS[unit.reason] };
  if (unit.unit.dimension !== dimension) return { ok: false, message: `This item is counted in ${dimension.startsWith('count:') ? dimension.slice(6) : dimension === 'mass' ? 'weight' : 'volume'}; use a matching unit.` };
  const scaled = multiply(parsed.value.lo, unit.unit.factor);
  const scale = dimension === 'mass' || dimension === 'volume' ? SCALE[dimension] : 1n;
  const exact = scaled.n * scale;
  if (scale === 1n && exact % scaled.d !== 0n) return { ok: false, message: 'Counts must be whole numbers. Use a weight or volume item for partial amounts.' };
  const qty = (exact + scaled.d - 1n) / scaled.d; // smallest whole base unit not below the entry
  if (qty > BigInt(MAX_STOCK)) return { ok: false, message: 'That amount is too large.' };
  return { ok: true, qty: Number(qty), text: `${entry.amount.trim().replace(/\s+/g, ' ')} ${entry.unit.trim().replace(/\s+/g, ' ')}`.slice(0, 60) };
}

const DISPLAY: Readonly<Record<'mass' | 'volume', readonly (readonly [string, number])[]>> = {
  mass: [['kg', 1e12], ['g', 1e9], ['mg', 1e6], ['µg', 1e3], ['ng', 1]],
  volume: [['L', 1e9], ['mL', 1e6], ['µL', 1e3], ['nL', 1]],
};
const trim = (value: number) => String(Math.round(value * 1000) / 1000);

/** Display only; the stored integer remains the source of truth. */
export function formatStock(qty: number, dimension: StockDimension): string {
  if (dimension.startsWith('count:')) {
    const unit = dimension.slice(6);
    return `${qty} ${qty === 1 ? unit : unit === 'bunch' ? 'bunches' : `${unit}s`}`;
  }
  const units = DISPLAY[dimension as 'mass' | 'volume'];
  if (qty === 0) return `0 ${units.find(([name]) => name === 'g' || name === 'mL')![0]}`;
  const [name, factor] = units.find(([, factor]) => qty >= factor) ?? units.at(-1)!;
  return `${trim(qty / factor)} ${name}`;
}
