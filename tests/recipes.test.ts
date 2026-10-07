import { describe, expect, it } from 'vitest';
import { formatQuantity, ingredientAmount, parseIngredientLine, parseQuantity, scaleIngredient } from '../src/shared/recipes';

describe('recipe amount parsing', () => {
  it.each([
    ['1 1/2', 1.5], ['1½', 1.5], ['½', 0.5], ['⅔', 2 / 3], ['.25', .25], ['2.5', 2.5], ['3⁄4', .75],
  ])('reads %s exactly', (input, quantity) => expect(parseQuantity(input as string)).toEqual({ quantity }));
  it.each(['1–2', '1 - 2', '1 to 2'])('preserves range %s', input => {
    expect(parseQuantity(input)).toEqual({ quantity: 1, quantityMax: 2 });
  });
  it('supports mixed fractional ranges', () => {
    expect(parseQuantity('1½–2¾')).toEqual({ quantity: 1.5, quantityMax: 2.75 });
  });
  it.each(['', 'salt to taste', 'about 1', '0', '-1', '2–1', '1/0', 'NaN', 'Infinity', '1e3', '100001', '1–2–3', '1,000'])('does not invent a quantity for %s', input => {
    expect(parseQuantity(input)).toEqual({ quantity: null });
  });
  it('separates structured quantities and known units', () => {
    expect(parseIngredientLine('1½ cups plain flour')).toEqual({ name: 'plain flour', quantity: 1.5, unit: 'cups' });
    expect(parseIngredientLine('1–2 tbsp. olive oil')).toEqual({ name: 'olive oil', quantity: 1, quantityMax: 2, unit: 'tbsp' });
    expect(parseIngredientLine('200g plain flour')).toEqual({ name: 'plain flour', quantity: 200, unit: 'g' });
    expect(parseIngredientLine('1½cups plain flour')).toEqual({ name: 'plain flour', quantity: 1.5, unit: 'cups' });
    expect(parseIngredientLine('1–2kg potatoes')).toEqual({ name: 'potatoes', quantity: 1, quantityMax: 2, unit: 'kg' });
    expect(parseIngredientLine('2x stock cubes')).toEqual({ name: '2x stock cubes', quantity: null, unit: '' });
  });
  it('preserves ambiguous quantities, package sizes and preparation wording', () => {
    expect(parseIngredientLine('Salt to taste')).toEqual({ name: 'Salt to taste', quantity: null, unit: '' });
    expect(parseIngredientLine('about 2 handfuls spinach').quantity).toBeNull();
    expect(parseIngredientLine('1 (400 g) can tomatoes')).toEqual({ name: '(400 g) can tomatoes', quantity: 1, unit: '' });
    expect(parseIngredientLine('2 large eggs')).toEqual({ name: 'large eggs', quantity: 2, unit: '' });
    expect(parseIngredientLine('2')).toEqual({ name: '2', quantity: null, unit: '' });
  });
});

describe('serving scaling', () => {
  it('scales both endpoints and leaves the original untouched', () => {
    const ingredient = { name: 'flour', quantity: .5, quantityMax: 1.5, unit: 'cups' };
    expect(scaleIngredient(ingredient, 2)).toEqual({ ...ingredient, quantity: 1, quantityMax: 3 });
    expect(ingredientAmount(ingredient, .5)).toBe('1/4–3/4');
    expect(ingredient.quantity).toBe(.5);
  });
  it('preserves a to-taste instruction without inventing an amount', () => {
    const ingredient = { name: 'salt, to taste', quantity: null, unit: '' };
    expect(scaleIngredient(ingredient, 4)).toEqual(ingredient);
    expect(ingredientAmount(ingredient, 4)).toBe('');
  });
  it.each([0, -1, NaN, Infinity])('rejects invalid scaling factor %s', multiplier => {
    expect(() => scaleIngredient({ name: 'egg', quantity: 1, unit: '' }, multiplier)).toThrow(RangeError);
  });
  it('rejects numeric overflow instead of displaying a missing amount', () => {
    expect(() => ingredientAmount({ name: 'flour', quantity: 2, unit: 'cups' }, Number.MAX_VALUE)).toThrow(RangeError);
  });
  it('formats cooking fractions without rounding tiny amounts to zero', () => {
    expect(formatQuantity(1 / 3)).toBe('1/3');
    expect(formatQuantity(1.75)).toBe('1 3/4');
    expect(formatQuantity(.001)).toBe('0.001');
    expect(formatQuantity(0)).toBe('');
  });
});
