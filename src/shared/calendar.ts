const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Calendar dates are UTC-based day numbers, never local-midnight timestamps. */
function dateValue(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Invalid calendar date: ${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(0);
  value.setUTCFullYear(year, month - 1, day);
  value.setUTCHours(0, 0, 0, 0);
  if (year < 1 || value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return value.getTime();
}

export function isValidDate(date: string): boolean {
  try { dateValue(date); return true; } catch { return false; }
}

export function todayInTimezone(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value;
  return `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
}

export function addDays(date: string, amount: number): string {
  if (!Number.isInteger(amount)) throw new RangeError('Day offset must be a whole number.');
  const result = new Date(dateValue(date) + amount * DAY_MS).toISOString().slice(0, 10);
  if (!isValidDate(result)) throw new RangeError('Date is outside the supported calendar.');
  return result;
}

/** Positive when end follows start; independent of daylight saving transitions. */
export function daysBetween(start: string, end: string): number {
  return (dateValue(end) - dateValue(start)) / DAY_MS;
}

export function formatDate(date: string, options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }, locale = 'en-US'): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(dateValue(date));
}

export function monthDays(month: string): string[] {
  const first = `${month.slice(0, 7)}-01`;
  dateValue(first);
  const result: string[] = [];
  let day = first;
  while (day.slice(0, 7) === first.slice(0, 7)) {
    result.push(day);
    day = addDays(day, 1);
  }
  return result;
}

/** Monday-first cells, including leading/trailing blanks for a stable calendar. */
export function monthGrid(month: string): (string | null)[] {
  const days = monthDays(month);
  const weekday = new Date(dateValue(days[0])).getUTCDay();
  const leading = (weekday + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(leading).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function shiftMonth(month: string, amount: number): string {
  if (!Number.isInteger(amount)) throw new RangeError('Month offset must be a whole number.');
  const value = new Date(dateValue(`${month.slice(0, 7)}-01`));
  value.setUTCMonth(value.getUTCMonth() + amount);
  return value.toISOString().slice(0, 7);
}

export function streaksForDates(dates: readonly string[], today: string): { current: number; longest: number; total: number } {
  const todayValue = dateValue(today);
  const days = [...new Set(dates.filter(date => isValidDate(date) && date <= today))].sort();
  let longest = 0;
  let run = 0;
  for (let index = 0; index < days.length; index += 1) {
    run = index > 0 && daysBetween(days[index - 1], days[index]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const completed = new Set(days.map(dateValue));
  let cursor = completed.has(todayValue) ? todayValue : todayValue - DAY_MS;
  let current = 0;
  while (completed.has(cursor)) {
    current += 1;
    cursor -= DAY_MS;
  }
  return { current, longest, total: days.length };
}
