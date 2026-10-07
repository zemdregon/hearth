import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatDate, isValidDate, monthDays, monthGrid, shiftMonth, streaksForDates, todayInTimezone } from '../src/shared/calendar';

describe('family calendar dates', () => {
  it('uses the configured family timezone at opposite sides of midnight', () => {
    const now = new Date('2026-10-07T00:30:00Z');
    expect(todayInTimezone('America/Los_Angeles', now)).toBe('2026-10-06');
    expect(todayInTimezone('Pacific/Auckland', now)).toBe('2026-10-07');
    expect(todayInTimezone('Pacific/Kiritimati', new Date('2026-12-31T12:30:00Z'))).toBe('2027-01-01');
  });

  it('recognizes a family day across a daylight saving change', () => {
    expect(todayInTimezone('America/New_York', new Date('2026-03-08T06:59:00Z'))).toBe('2026-03-08');
    expect(todayInTimezone('America/New_York', new Date('2026-03-08T07:01:00Z'))).toBe('2026-03-08');
    expect(todayInTimezone('America/New_York', new Date('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
    expect(todayInTimezone('America/New_York', new Date('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
  });

  it('performs whole day arithmetic without local-midnight or DST errors', () => {
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2026-11-02', -2)).toBe('2026-10-31');
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-11-02', '2026-10-31')).toBe(-2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles leap years including the Gregorian century exception', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01');
    expect(isValidDate('1900-02-29')).toBe(false);
  });

  it('rejects invalid, noncanonical, and fractional calendar inputs', () => {
    for (const value of ['2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-01', 'not-a-date', '0000-01-01']) {
      expect(isValidDate(value), value).toBe(false);
      expect(() => addDays(value, 1), value).toThrow(RangeError);
    }
    expect(() => addDays('2026-01-01', 0.5)).toThrow(RangeError);
    expect(isValidDate('0099-01-01')).toBe(true);
    expect(addDays('0099-12-31', 1)).toBe('0100-01-01');
  });

  it('formats dates without letting the browser timezone move the day', () => {
    expect(formatDate('2026-10-07')).toBe('Oct 7, 2026');
    expect(formatDate('2026-10-07', { day: 'numeric', timeZone: 'America/Los_Angeles' })).toBe('7');
  });

  it('creates leap-month and Monday-first calendars with stable rows', () => {
    expect(monthDays('2024-02')).toHaveLength(29);
    expect(monthDays('2026-02')).toHaveLength(28);
    expect(monthDays('2026-12').at(-1)).toBe('2026-12-31');
    const monday = monthGrid('2026-06');
    expect(monday[0]).toBe('2026-06-01');
    expect(monday.length % 7).toBe(0);
    const sunday = monthGrid('2026-02');
    expect(sunday.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(sunday[6]).toBe('2026-02-01');
    expect(sunday.filter(Boolean)).toHaveLength(28);
  });

  it('navigates months across year boundaries without overflowing short months', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2024-01-31', 1)).toBe('2024-02');
  });
});

describe('habit streaks', () => {
  it('starts with no progress', () => {
    expect(streaksForDates([], '2026-10-07')).toEqual({ current: 0, longest: 0, total: 0 });
  });

  it('counts the first supported calendar day without underflowing the year', () => {
    expect(streaksForDates(['0001-01-01'], '0001-01-01')).toEqual({ current: 1, longest: 1, total: 1 });
  });

  it('counts today and gives an unfinished today a one-day grace period', () => {
    expect(streaksForDates(['2026-10-05', '2026-10-06'], '2026-10-07')).toEqual({ current: 2, longest: 2, total: 2 });
    expect(streaksForDates(['2026-10-05', '2026-10-06', '2026-10-07'], '2026-10-07')).toEqual({ current: 3, longest: 3, total: 3 });
    expect(streaksForDates(['2026-10-05', '2026-10-06'], '2026-10-08')).toEqual({ current: 0, longest: 2, total: 2 });
  });

  it('preserves the longest streak when starting again after a gap', () => {
    expect(streaksForDates(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-06', '2026-10-07'], '2026-10-07')).toEqual({ current: 2, longest: 3, total: 5 });
  });

  it('deduplicates unsorted logs and excludes malformed or future dates', () => {
    expect(streaksForDates(['2026-10-07', '2026-10-06', '2026-10-07', '2026-10-08', '2026-02-30', 'oops'], '2026-10-07')).toEqual({ current: 2, longest: 2, total: 2 });
  });

  it('counts uninterrupted runs over leap day and the year boundary', () => {
    expect(streaksForDates(['2024-02-28', '2024-02-29', '2024-03-01'], '2024-03-02').current).toBe(3);
    expect(streaksForDates(['2025-12-30', '2025-12-31', '2026-01-01'], '2026-01-01').current).toBe(3);
  });

  it('counts DST spring-forward and fall-back as adjacent calendar days', () => {
    expect(streaksForDates(['2026-03-07', '2026-03-08', '2026-03-09'], '2026-03-09').current).toBe(3);
    expect(streaksForDates(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02').current).toBe(3);
  });
});
