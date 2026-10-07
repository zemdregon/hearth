import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isValidDate } from '../src/shared/calendar';
import { questionBank, questionById, questionCycles, questionForDate, questionIdForDate } from '../src/shared/questions';
import type { QuestionCycle } from '../src/shared/questions';
import legacy from './fixtures/questions-v1.json';

const legacyIds = legacy.questions.map(question => question.id);
const legacyCycle: QuestionCycle = { effectiveFrom: legacy.effectiveFrom, epoch: legacy.epoch, questionIds: legacyIds };
const futureCycle: QuestionCycle = {
  effectiveFrom: '2027-01-01', epoch: '2027-01-01', questionIds: ['small-care', 'new-v2', 'recharge'],
};
const expandedSchedule = [legacyCycle, futureCycle];

describe('daily connection questions', () => {
  it('preserves the exact published v1 catalog, choice order, and date cycle', () => {
    // This fixture is a compatibility contract, not a snapshot to update when adding prompts.
    expect(questionBank.slice(0, legacy.questions.length)).toEqual(legacy.questions);
    expect(questionCycles[0]).toEqual(legacyCycle);
    for (const question of legacy.questions) expect(questionById(question.id)).toEqual(question);
  });

  it('selects the same prompt deterministically for every member on a date', () => {
    expect(questionForDate('2026-01-01').id).toBe('recharge');
    expect(questionForDate('2026-01-02').id).toBe('small-care');
    expect(questionForDate('2026-01-01')).toBe(questionById('recharge'));
  });

  it('covers every question before repeating, including dates before the epoch', () => {
    const cycle = Array.from({ length: legacyIds.length }, (_, index) => questionForDate(addDays('2025-12-15', index)).id);
    expect(new Set(cycle).size).toBe(legacyIds.length);
    expect(questionForDate(addDays(legacy.epoch, legacyIds.length)).id).toBe('recharge');
    expect(questionForDate('2025-12-31').id).toBe('check-in');
  });

  it('moves to the next question across leap day and DST dates', () => {
    for (const date of ['2024-02-28', '2024-02-29', '2026-03-08', '2026-11-01']) {
      const index = legacyIds.indexOf(questionForDate(date).id);
      expect(questionForDate(addDays(date, 1)).id).toBe(legacyIds[(index + 1) % legacyIds.length]);
    }
  });

  it('keeps every earlier assignment when a differently sized future cycle is added', () => {
    const start = '2025-12-01';
    const end = '2027-01-01';
    for (let offset = 0; offset < daysBetween(start, end); offset += 1) {
      const date = addDays(start, offset);
      const day = daysBetween(legacy.epoch, date);
      const expected = legacyIds[((day % legacyIds.length) + legacyIds.length) % legacyIds.length];
      expect(questionIdForDate(date, expandedSchedule), date).toBe(expected);
    }
    expect(questionIdForDate('0001-01-01', expandedSchedule)).toBe(questionIdForDate('0001-01-01', [legacyCycle]));
  });

  it('switches exactly at the cutover and repeats using the new cycle alone', () => {
    expect(questionIdForDate('2026-12-31', expandedSchedule)).toBe('food-night');
    expect(questionIdForDate('2027-01-01', expandedSchedule)).toBe('small-care');
    expect(questionIdForDate('2027-01-02', expandedSchedule)).toBe('new-v2');
    expect(questionIdForDate('2027-01-03', expandedSchedule)).toBe('recharge');
    expect(questionIdForDate('2027-01-04', expandedSchedule)).toBe('small-care');
  });

  it('uses the latest applicable cycle while preserving earlier cycles after another cutover', () => {
    const schedule = [...expandedSchedule, {
      effectiveFrom: '2028-02-29', epoch: '2028-02-29', questionIds: ['v3-first', 'v3-second'],
    }];
    expect(questionIdForDate('2027-01-02', schedule)).toBe('new-v2');
    expect(questionIdForDate('2028-02-28', schedule)).toBe(questionIdForDate('2028-02-28', expandedSchedule));
    expect(questionIdForDate('2028-02-29', schedule)).toBe('v3-first');
    expect(questionIdForDate('2028-03-01', schedule)).toBe('v3-second');
    expect(questionIdForDate('2028-03-02', schedule)).toBe('v3-first');
  });

  it('retains the meaning of saved answers when a question leaves the active cycle', () => {
    const saved = { date: '2026-01-03', questionId: 'weekend', choice: 2 };
    expect(futureCycle.questionIds).not.toContain(saved.questionId);
    expect(questionIdForDate(saved.date, expandedSchedule)).toBe(saved.questionId);
    const question = questionById(saved.questionId);
    expect(question?.prompt).toBe('Your ideal free Saturday starts with…');
    expect(question?.profileLabel).toBe('My ideal Saturday morning');
    expect(question?.choices[saved.choice]).toBe('Making something creative');
  });

  it('keeps configured cycles complete, ordered, and linked to the permanent catalog', () => {
    expect(questionCycles.length).toBeGreaterThan(0);
    expect(questionCycles[0].effectiveFrom).toBeNull();
    let previousBoundary: string | null = null;
    for (const [index, cycle] of questionCycles.entries()) {
      expect(isValidDate(cycle.epoch)).toBe(true);
      expect(cycle.questionIds.length).toBeGreaterThan(0);
      expect(new Set(cycle.questionIds).size).toBe(cycle.questionIds.length);
      expect(cycle.questionIds.every(id => questionById(id) !== undefined)).toBe(true);
      if (index > 0) {
        expect(cycle.effectiveFrom).not.toBeNull();
        expect(isValidDate(cycle.effectiveFrom!)).toBe(true);
        if (previousBoundary) expect(cycle.effectiveFrom! > previousBoundary).toBe(true);
      }
      previousBoundary = cycle.effectiveFrom;
    }
  });

  it('prevents runtime edits to published content, choice indexes, and cycle assignments', () => {
    expect(Reflect.set(questionBank, questionBank.length, questionBank[0])).toBe(false);
    expect(Reflect.set(questionBank[0], 'prompt', 'Changed prompt')).toBe(false);
    expect(Reflect.set(questionBank[0].choices, 0, 'Changed choice')).toBe(false);
    expect(Reflect.set(questionBank[0], 'choices', ['Changed choice'])).toBe(false);
    expect(Reflect.set(questionCycles, questionCycles.length, futureCycle)).toBe(false);
    expect(Reflect.set(questionCycles[0], 'epoch', '2027-01-01')).toBe(false);
    expect(Reflect.set(questionCycles[0].questionIds, 0, 'small-care')).toBe(false);
  });

  it('has stable unique IDs and complete useful profile labels and choices', () => {
    expect(new Set(questionBank.map(question => question.id)).size).toBe(questionBank.length);
    expect(questionBank.length).toBeGreaterThanOrEqual(28);
    for (const question of questionBank) {
      expect(questionById(question.id)).toBe(question);
      expect(question.prompt.length).toBeGreaterThan(10);
      expect(question.profileLabel.length).toBeGreaterThan(5);
      expect(question.choices).toHaveLength(4);
      expect(new Set(question.choices).size).toBe(4);
      expect(question.choices.every(choice => choice.trim().length > 0)).toBe(true);
    }
    expect(questionById('not-a-question')).toBeUndefined();
  });

  it('rejects malformed dates instead of selecting a random or missing prompt', () => {
    for (const date of ['2026-02-30', '2027-02-29', '2027-1-01', 'not-a-date']) {
      expect(() => questionForDate(date)).toThrow(RangeError);
      expect(() => questionIdForDate(date, expandedSchedule)).toThrow(RangeError);
    }
  });

  it('rejects schedules with no fallback or no choices for the selected cycle', () => {
    expect(() => questionIdForDate('2027-01-01', [])).toThrow(RangeError);
    expect(() => questionIdForDate('2027-01-01', [futureCycle])).toThrow(RangeError);
    expect(() => questionIdForDate('2027-01-01', [{ ...legacyCycle, questionIds: [] }])).toThrow(RangeError);
  });
});
