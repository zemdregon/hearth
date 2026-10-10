import type { Ingredient } from './types';

const fractionGlyphs: Record<string, string> = {
  '¼': '1/4', '½': '1/2', '¾': '3/4', '⅐': '1/7', '⅑': '1/9', '⅒': '1/10',
  '⅓': '1/3', '⅔': '2/3', '⅕': '1/5', '⅖': '2/5', '⅗': '3/5', '⅘': '4/5',
  '⅙': '1/6', '⅚': '5/6', '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
};
const numberPattern = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|(?:\\d+(?:\\.\\d+)?|\\.\\d+))';
const rangePattern = new RegExp(`^(${numberPattern})(?:\\s*(?:[-–—]|to)\\s*(${numberPattern}))?$`, 'i');
const leadingAmountPattern = new RegExp(`^(${numberPattern}(?:\\s*(?:[-–—]|to)\\s*${numberPattern})?)(?=\\s|$)`,'i');
const compactAmountPattern = new RegExp(`^(${numberPattern}(?:\\s*(?:[-–—]|to)\\s*${numberPattern})?)([a-z]+)\\s+(.+)$`, 'i');
const units = new Set(['tsp', 'teaspoon', 'teaspoons', 'tbsp', 'tablespoon', 'tablespoons', 'cup', 'cups', 'g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'mg', 'ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'l', 'liter', 'liters', 'litre', 'litres', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds', 'pinch', 'pinches', 'dash', 'dashes', 'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'package', 'packages', 'packet', 'packets', 'bunch', 'bunches', 'slice', 'slices', 'sprig', 'sprigs', 'piece', 'pieces']);

function normalizeFractions(value: string): string {
  return value.replace(/[¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, (character) => ` ${fractionGlyphs[character]}`).replace(/⁄/g, '/').trim().replace(/\s+/g, ' ');
}

function parseNumber(value: string): number | null {
  const parts = value.trim().split(/\s+/);
  let result = 0;
  for (const part of parts) {
    if (part.includes('/')) {
      const [numerator, denominator] = part.split('/').map(Number);
      if (!denominator || !Number.isFinite(numerator)) return null;
      result += numerator / denominator;
    } else result += Number(part);
  }
  return Number.isFinite(result) && result > 0 && result <= 100_000 ? result : null;
}

/** Accept only exact numeric amounts. Unknown amounts remain unquantified. */
export function parseQuantity(value: string): { quantity: number | null; quantityMax?: number } {
  const match = normalizeFractions(value).match(rangePattern);
  if (!match) return { quantity: null };
  const quantity = parseNumber(match[1]);
  if (quantity === null) return { quantity: null };
  if (!match[2]) return { quantity };
  const quantityMax = parseNumber(match[2]);
  if (quantityMax === null || quantityMax < quantity) return { quantity: null };
  return quantityMax === quantity ? { quantity } : { quantity, quantityMax };
}

/** Parse a conservative leading amount/unit; never guess an ingredient's quantity. */
export function parseIngredientLine(value: string): Ingredient {
  const original = value.trim();
  const normalized = normalizeFractions(original);
  const compact = normalized.match(compactAmountPattern);
  if (compact && units.has(compact[2].toLowerCase())) {
    const amount = parseQuantity(compact[1]);
    if (amount.quantity !== null) return { ...amount, name: compact[3].trim(), unit: compact[2] };
    return { name: original, quantity: null, unit: '' };
  }
  const match = normalized.match(leadingAmountPattern);
  if (!match) return { name: original, quantity: null, unit: '' };
  const amount = parseQuantity(match[1]);
  let remainder = normalized.slice(match[0].length).trim();
  if (amount.quantity === null || !remainder) return { name: original, quantity: null, unit: '' };
  let unit = '';
  const firstWord = remainder.match(/^([^\s]+)\s+(.+)$/);
  if (firstWord && units.has(firstWord[1].replace(/\.$/, '').toLowerCase())) {
    unit = firstWord[1].replace(/\.$/, '');
    remainder = firstWord[2].trim();
  }
  return { ...amount, name: remainder, unit };
}

export function formatQuantity(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '';
  const whole = Math.floor(value);
  const remainder = value - whole;
  if (remainder < 0.00001) return String(whole);
  // Friendly cooking fractions without turning a small nonzero amount into zero.
  for (const denominator of [2, 3, 4, 5, 6, 8, 10, 12, 16]) {
    const numerator = Math.round(remainder * denominator);
    if (numerator > 0 && numerator < denominator && Math.abs(numerator / denominator - remainder) < 0.0005) {
      return `${whole ? `${whole} ` : ''}${numerator}/${denominator}`;
    }
  }
  return new Intl.NumberFormat('en', { maximumSignificantDigits: 5, useGrouping: false }).format(value);
}

// Written-out units whose singular and plural differ only by the ending ("cup"/"cups", "pinch"/"pinches").
const unitForms = new Map<string, [string, string]>();
for (const [singular, plural] of [['teaspoon', 'teaspoons'], ['tablespoon', 'tablespoons'], ['cup', 'cups'], ['gram', 'grams'], ['kilogram', 'kilograms'],
  ['milliliter', 'milliliters'], ['millilitre', 'millilitres'], ['liter', 'liters'], ['litre', 'litres'], ['ounce', 'ounces'], ['pound', 'pounds'],
  ['pinch', 'pinches'], ['dash', 'dashes'], ['clove', 'cloves'], ['can', 'cans'], ['tin', 'tins'], ['package', 'packages'], ['packet', 'packets'],
  ['bunch', 'bunches'], ['slice', 'slices'], ['sprig', 'sprigs'], ['piece', 'pieces']] as [string, string][]) {
  unitForms.set(singular, [singular, plural]);
  unitForms.set(plural, [singular, plural]);
}

/** The unit as it reads for the scaled amount: "1/2 cup" and "1 cup", but "1 1/2 cups" and "2 cups". Abbreviations are left alone. */
export function ingredientUnit(ingredient: Ingredient, multiplier = 1): string {
  const forms = unitForms.get(ingredient.unit.trim().toLowerCase());
  if (!forms || ingredient.quantity === null) return ingredient.unit;
  const scaled = scaleIngredient(ingredient, multiplier);
  const largest = Math.max(scaled.quantity ?? 0, scaled.quantityMax ?? 0);
  const word = largest <= 1 ? forms[0] : forms[1];
  return ingredient.unit[0] === ingredient.unit[0].toUpperCase() && ingredient.unit[0] !== ingredient.unit[0].toLowerCase() ? word[0].toUpperCase() + word.slice(1) : word;
}

export function ingredientAmount(ingredient: Ingredient, multiplier = 1): string {
  const scaled = scaleIngredient(ingredient, multiplier);
  if (scaled.quantity === null) return '';
  const amount = formatQuantity(scaled.quantity);
  return scaled.quantityMax !== undefined && scaled.quantityMax > scaled.quantity
    ? `${amount}–${formatQuantity(scaled.quantityMax)}`
    : amount;
}

export function scaleIngredient(ingredient: Ingredient, multiplier: number): Ingredient {
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new RangeError('The serving multiplier must be positive.');
  if (ingredient.quantity === null) return { ...ingredient };
  if (!Number.isFinite(ingredient.quantity * multiplier) || (ingredient.quantityMax !== undefined && !Number.isFinite(ingredient.quantityMax * multiplier))) throw new RangeError('The scaled quantity is too large.');
  return {
    ...ingredient,
    quantity: ingredient.quantity * multiplier,
    ...(ingredient.quantityMax !== undefined ? { quantityMax: ingredient.quantityMax * multiplier } : {}),
  };
}

export function durationLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Time not set';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} hr${rest ? ` ${rest} min` : ''}` : `${rest} min`;
}
