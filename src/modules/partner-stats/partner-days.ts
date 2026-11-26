/** Partners whose players are counted into Quizball's totals (partner_daily_stats.partner). */
export const TABLE_DERBY = 'table-derby';

const TZ = 'Asia/Tbilisi';

export function tbilisiDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
