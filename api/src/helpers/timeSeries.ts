// Shared time-series granularity/label helper used by GET /api/movements/series.
// The /api/dashboard endpoint keeps its own (period-anchored) bucketing and is
// intentionally NOT routed through here so its output stays byte-for-byte stable.

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export interface TimeSeriesFormat {
  granularity: Granularity;
  // DATE_TRUNC unit used to bucket movements and the generate_series bounds.
  truncUnit: Granularity;
  // to_char format applied to each bucket to produce its label.
  labelFormat: string;
  // generate_series step.
  interval: string;
}

const MS_PER_DAY = 86_400_000;

// Number of whole days spanned by an inclusive [from, to] ISO-date range
// (0 when from === to).
export function spanInDays(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  return Math.round((toMs - fromMs) / MS_PER_DAY);
}

// Pick a bucket granularity that keeps the chart readable for the given span:
//   span ≤ 1 day   → hourly
//   span ≤ 92 days → daily
//   span ≤ 730 days→ weekly (ISO week, label = the week's Monday)
//   longer         → monthly
export function chooseGranularity(from: string, to: string): Granularity {
  const span = spanInDays(from, to);
  if (span <= 1) return 'hour';
  if (span <= 92) return 'day';
  if (span <= 730) return 'week';
  return 'month';
}

export function timeSeriesFormat(granularity: Granularity): TimeSeriesFormat {
  switch (granularity) {
    case 'hour':
      return { granularity, truncUnit: 'hour', labelFormat: 'HH24:MI', interval: '1 hour' };
    case 'day':
      return { granularity, truncUnit: 'day', labelFormat: 'YYYY-MM-DD', interval: '1 day' };
    case 'week':
      return { granularity, truncUnit: 'week', labelFormat: 'YYYY-MM-DD', interval: '1 week' };
    case 'month':
      return { granularity, truncUnit: 'month', labelFormat: 'Mon YYYY', interval: '1 month' };
  }
}
