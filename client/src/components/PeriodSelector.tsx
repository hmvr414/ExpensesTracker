import { useRef } from 'react';
import type { DashboardPeriod } from '../api/dashboard';

const PERIODS: DashboardPeriod[] = ['day', 'week', 'month', 'year', 'all'];
const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
  all: 'All',
};

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

export function getPeriodLabel(period: DashboardPeriod, anchor: string): string {
  if (period === 'all') return 'All Time';
  const d = new Date(anchor + 'T00:00:00');
  switch (period) {
    case 'day':
      return `${DAYS_FULL[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
    case 'week': {
      const dow = d.getDay();
      const startOffset = dow === 0 ? -6 : 1 - dow;
      const start = new Date(d);
      start.setDate(d.getDate() + startOffset);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      if (start.getMonth() === end.getMonth()) {
        return `Week of ${MONTHS_SHORT[start.getMonth()]} ${start.getDate()}–${end.getDate()}`;
      }
      return `Week of ${MONTHS_SHORT[start.getMonth()]} ${start.getDate()}–${MONTHS_SHORT[end.getMonth()]} ${end.getDate()}`;
    }
    case 'month':
      return `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
    case 'year':
      return String(d.getFullYear());
  }
}

export function navigatePeriod(period: DashboardPeriod, anchor: string, direction: 'prev' | 'next'): string {
  const d = new Date(anchor + 'T00:00:00');
  const delta = direction === 'next' ? 1 : -1;
  switch (period) {
    case 'day':
      d.setDate(d.getDate() + delta);
      break;
    case 'week':
      d.setDate(d.getDate() + 7 * delta);
      break;
    case 'month':
      d.setMonth(d.getMonth() + delta);
      break;
    case 'year':
      d.setFullYear(d.getFullYear() + delta);
      break;
  }
  return d.toISOString().split('T')[0];
}

export function isNextDisabled(period: DashboardPeriod, anchor: string): boolean {
  if (period === 'all') return true;
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const d = new Date(anchor + 'T00:00:00');
  switch (period) {
    case 'day':
      return anchor >= todayStr;
    case 'week': {
      const nextAnchor = navigatePeriod(period, anchor, 'next');
      return nextAnchor > todayStr;
    }
    case 'month':
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
    case 'year':
      return d.getFullYear() >= today.getFullYear();
  }
}

interface PeriodSelectorProps {
  period: DashboardPeriod;
  anchor: string;
  onPeriodChange: (period: DashboardPeriod, anchor: string) => void;
  loading?: boolean;
}

export function PeriodSelector({ period, anchor, onPeriodChange, loading }: PeriodSelectorProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  function handleNav(direction: 'prev' | 'next') {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const newAnchor = navigatePeriod(period, anchor, direction);
      onPeriodChange(period, newAnchor);
    }, 150);
  }

  const nextDisabled = isNextDisabled(period, anchor);
  const label = getPeriodLabel(period, anchor);

  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
        {PERIODS.map((p) => (
          <button
            key={p}
            onClick={() => onPeriodChange(p, anchor)}
            aria-pressed={period === p}
            className={`px-3 py-1.5 text-sm font-medium transition-colors ${
              period === p
                ? 'bg-primary-600 text-white'
                : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
            }`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {period !== 'all' && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => handleNav('prev')}
            aria-label="Previous period"
            className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors text-lg leading-none"
          >
            ‹
          </button>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300 min-w-[150px] text-center">
            {loading ? (
              <span
                aria-label="loading"
                className="inline-block w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full animate-spin"
              />
            ) : (
              label
            )}
          </span>
          <button
            onClick={() => handleNav('next')}
            disabled={nextDisabled}
            aria-label="Next period"
            className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-lg leading-none"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
