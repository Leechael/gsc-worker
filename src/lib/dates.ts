/**
 * Pacific Time date utilities.
 *
 * GSC startDate/endDate and the DATE/HOUR dimensions are Pacific Time
 * (UTC-7/-8). Docker containers run in arbitrary timezones and Workers always
 * run in UTC, so "today" is computed via Intl — never from the system clock's
 * local date (plan §1.5-11).
 */

const PT_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's date in America/Los_Angeles, as YYYY-MM-DD. */
export function ptToday(now: Date = new Date()): string {
  return PT_FORMATTER.format(now);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidISODate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Shift a YYYY-MM-DD date by n days. All math is done at UTC midnight so DST
 * transitions in Pacific Time never produce an off-by-one.
 */
export function shiftDays(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The last `days` complete days in PT, both ends inclusive:
 * end = yesterday-or-today PT (default today), start = end - (days - 1).
 * `days=28` covers exactly 28 days (Python版 covered 29 — see plan §9.2-4,
 * 按推荐语义实现，待负责人最终拍板).
 */
export function lastNDays(days: number, now?: Date): { start: string; end: string } {
  const end = ptToday(now);
  return { start: shiftDays(end, -(days - 1)), end };
}
