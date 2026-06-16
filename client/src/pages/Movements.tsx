import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import {
  getMovements,
  getMovementsSeries,
  Movement,
  GetMovementsParams,
  GetMovementsSeriesParams,
  MovementsSeriesResponse,
  MovementsSeriesGranularity,
} from '../api/movements';
import { getCategories, Category } from '../api/categories';
import {
  getPeriodLabel,
  navigatePeriod,
  isNextDisabled,
} from '../components/PeriodSelector';
import { MovementForm } from '../components/MovementForm';
import { paymentMethodIcon } from '../helpers/paymentMethod';

type MovPeriod = 'day' | 'week' | 'month';

// Format a series x-axis tick per the granularity the API chose: daily/weekly
// ISO dates collapse to MM/DD; hourly (HH:MI) and monthly (Mon YYYY) pass through.
export function formatSeriesTick(
  label: string,
  granularity: MovementsSeriesGranularity
): string {
  if (granularity === 'day' || granularity === 'week') {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(label);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return label;
}

const PERIOD_CHIPS: { value: MovPeriod; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

const PAGE_SIZE = 50;
const MAX_LIMIT = 200;
const FALLBACK_COLOR = '#6366f1';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayISO(): string {
  return toISO(new Date());
}

// Derive an inclusive [from, to] range from a period + anchor date, mirroring
// the dashboard's range math (weeks start Monday).
function periodRange(period: MovPeriod, anchor: string): { from: string; to: string } {
  const d = new Date(anchor + 'T00:00:00');
  if (Number.isNaN(d.getTime())) {
    const t = todayISO();
    return { from: t, to: t };
  }
  switch (period) {
    case 'day':
      return { from: anchor, to: anchor };
    case 'week': {
      const dow = d.getDay();
      const startOffset = dow === 0 ? -6 : 1 - dow;
      const start = new Date(d);
      start.setDate(d.getDate() + startOffset);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return { from: toISO(start), to: toISO(end) };
    }
    case 'month': {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return { from: toISO(start), to: toISO(end) };
    }
  }
}

function formatCurrency(amount: number): string {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr: string): string {
  const dateOnly = dateStr.includes('T') ? dateStr.slice(0, 10) : dateStr;
  const d = new Date(dateOnly + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      data-testid="skeleton"
      className={`animate-pulse bg-neutral-200 dark:bg-neutral-700 rounded ${className}`}
    />
  );
}

export function Movements() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Custom range mode is active whenever explicit from/to params are present;
  // otherwise the view is driven by period + anchor (default: current month).
  const customFrom = searchParams.get('from');
  const customTo = searchParams.get('to');
  const isCustom = customFrom !== null || customTo !== null;

  const period = (searchParams.get('period') as MovPeriod) ?? 'month';
  const anchor = searchParams.get('anchor') ?? todayISO();
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  // Category filter is mirrored in the URL (the multi-select control lands with
  // the next feature); read it here so the list call already honors it.
  const categoryIds = searchParams
    .getAll('category_id')
    .flatMap((v) => v.split(','))
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const uncategorized = searchParams.get('uncategorized') === 'true';
  const categoryKey = categoryIds.join(',');

  const range = isCustom
    ? { from: customFrom ?? '', to: customTo ?? '' }
    : periodRange(period, anchor);
  const rangeInvalid =
    isCustom && !!range.from && !!range.to && range.from > range.to;
  const rangeValid = !!range.from && !!range.to && range.from <= range.to;

  const [movements, setMovements] = useState<Movement[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const isFirstLoad = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editMovement, setEditMovement] = useState<Movement | undefined>(undefined);

  const [categories, setCategories] = useState<Category[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [series, setSeries] = useState<MovementsSeriesResponse | null>(null);
  const [seriesFetching, setSeriesFetching] = useState(false);

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
  }, []);

  // Spend-over-time series for the active range AND category filter, so the
  // chart always reflects exactly the rows in the table below it.
  useEffect(() => {
    if (!rangeValid) {
      setSeries(null);
      return;
    }
    let cancelled = false;
    setSeriesFetching(true);
    const params: GetMovementsSeriesParams = { from: range.from, to: range.to };
    if (categoryIds.length) params.category_id = categoryIds;
    if (uncategorized) params.uncategorized = true;

    getMovementsSeries(params)
      .then((res) => {
        if (cancelled) return;
        setSeries(res);
        setSeriesFetching(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSeriesFetching(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, rangeValid, refreshKey, categoryKey, uncategorized]);

  useEffect(() => {
    if (!rangeValid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (!isFirstLoad.current) setFetching(true);

    const params: GetMovementsParams = {
      from: range.from,
      to: range.to,
      page: 1,
      limit: Math.min(page * PAGE_SIZE, MAX_LIMIT),
    };
    if (categoryIds.length) params.category_id = categoryIds;
    if (uncategorized) params.uncategorized = true;

    getMovements(params)
      .then((res) => {
        if (cancelled) return;
        setMovements(res.data);
        setTotal(res.total);
        setTotalAmount(res.totalAmount);
        isFirstLoad.current = false;
        setLoading(false);
        setFetching(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setFetching(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, rangeValid, page, refreshKey, categoryKey, uncategorized]);

  // Build a new URL param set, preserving the active category filter.
  function buildParams(base: Record<string, string>): URLSearchParams {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(base)) sp.set(k, v);
    for (const id of categoryIds) sp.append('category_id', String(id));
    if (uncategorized) sp.set('uncategorized', 'true');
    return sp;
  }

  function selectPeriod(p: MovPeriod) {
    setSearchParams(buildParams({ period: p, anchor }));
  }

  function handleNav(direction: 'prev' | 'next') {
    const newAnchor = navigatePeriod(period, anchor, direction);
    setSearchParams(buildParams({ period, anchor: newAnchor }));
  }

  function selectCustom() {
    setSearchParams(buildParams({ from: range.from, to: range.to }));
  }

  function setCustom(from: string, to: string) {
    setSearchParams(buildParams({ from, to }));
  }

  function loadMore() {
    const next = String(page + 1);
    setSearchParams(
      isCustom
        ? buildParams({ from: range.from, to: range.to, page: next })
        : buildParams({ period, anchor, page: next })
    );
  }

  // Replace the category selection in the URL, preserving the active view
  // (period+anchor or custom from/to) and resetting pagination to page 1.
  function setSelection(ids: number[], uncat: boolean) {
    const sp = new URLSearchParams();
    const base = isCustom
      ? { from: range.from, to: range.to }
      : { period, anchor };
    for (const [k, v] of Object.entries(base)) sp.set(k, v);
    for (const id of ids) sp.append('category_id', String(id));
    if (uncat) sp.set('uncategorized', 'true');
    setSearchParams(sp);
  }

  function toggleCategory(id: number) {
    const next = categoryIds.includes(id)
      ? categoryIds.filter((c) => c !== id)
      : [...categoryIds, id];
    setSelection(next, uncategorized);
  }

  function toggleUncategorized() {
    setSelection(categoryIds, !uncategorized);
  }

  function resetCategories() {
    setSelection([], false);
  }

  function openEditForm(m: Movement) {
    setEditMovement(m);
    setFormOpen(true);
  }

  function openAddForm() {
    setEditMovement(undefined);
    setFormOpen(true);
  }

  function handleFormSaved() {
    setRefreshKey((k) => k + 1);
  }

  const headerLabel = isCustom
    ? range.from && range.to
      ? `${range.from} – ${range.to}`
      : 'Custom range'
    : getPeriodLabel(period as MovPeriod, anchor);
  const nextDisabled = isCustom || isNextDisabled(period as MovPeriod, anchor);
  const hasMore = movements.length < total;

  const selectedCount = categoryIds.length + (uncategorized ? 1 : 0);
  // The chart takes a single category's color only when exactly one real
  // category (and nothing else) is selected; otherwise the primary color.
  const singleCategory =
    categoryIds.length === 1 && !uncategorized
      ? categories.find((c) => c.id === categoryIds[0])
      : undefined;
  const chartColor = singleCategory?.color ?? FALLBACK_COLOR;

  const comparison = series?.comparison;
  const showTrend =
    !!comparison && comparison.previousTotal !== 0 && comparison.deltaPct != null;
  const trendUp = !!comparison && (comparison.deltaPct ?? 0) >= 0;
  const periodNoun = isCustom ? 'period' : period;
  const seriesAllZero =
    !!series && series.data.every((p) => p.total === 0);
  const currentTotal = comparison?.currentTotal ?? 0;

  return (
    <>
      <main className="flex-1 overflow-y-auto p-6 space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Movements</h1>
          <button
            onClick={openAddForm}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors whitespace-nowrap"
          >
            + Add Expense
          </button>
        </div>

        {/* Period control */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              {PERIOD_CHIPS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => selectPeriod(p.value)}
                  aria-pressed={!isCustom && period === p.value}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    !isCustom && period === p.value
                      ? 'bg-primary-600 text-white'
                      : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                  }`}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={selectCustom}
                aria-pressed={isCustom}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  isCustom
                    ? 'bg-primary-600 text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
              >
                Custom range
              </button>
            </div>

            {!isCustom && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleNav('prev')}
                  aria-label="Previous period"
                  className="p-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors text-lg leading-none"
                >
                  ‹
                </button>
                <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300 min-w-[150px] text-center">
                  {headerLabel}
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

            {isCustom && (
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400">
                  <span className="sr-only">From date</span>
                  <input
                    type="date"
                    aria-label="From date"
                    value={customFrom ?? ''}
                    onChange={(e) => setCustom(e.target.value, customTo ?? '')}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </label>
                <span className="text-neutral-400">–</span>
                <label className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400">
                  <span className="sr-only">To date</span>
                  <input
                    type="date"
                    aria-label="To date"
                    value={customTo ?? ''}
                    onChange={(e) => setCustom(customFrom ?? '', e.target.value)}
                    className="rounded-md border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-sm bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </label>
              </div>
            )}
          </div>
          {rangeInvalid && (
            <p role="alert" className="text-sm text-danger-600">
              From date must be on or before To date.
            </p>
          )}
        </div>

        {/* Category multi-select filter */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <button
              onClick={() => setPickerOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors flex items-center gap-1"
            >
              Categories
              {selectedCount > 0 && (
                <span className="ml-1 px-1.5 rounded-full bg-primary-600 text-white text-xs">
                  {selectedCount}
                </span>
              )}
              <span className="text-xs">▾</span>
            </button>
            {pickerOpen && (
              <ul
                role="listbox"
                aria-label="Filter by category"
                className="absolute z-10 mt-1 w-56 max-h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-lg py-1"
              >
                {categories.map((c) => {
                  const checked = categoryIds.includes(c.id);
                  return (
                    <li key={c.id}>
                      <button
                        role="option"
                        aria-selected={checked}
                        onClick={() => toggleCategory(c.id)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                      >
                        <span
                          className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: c.color ?? FALLBACK_COLOR }}
                        />
                        <span className="flex-1 truncate">{c.name}</span>
                        {checked && <span className="text-primary-600">✓</span>}
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button
                    role="option"
                    aria-selected={uncategorized}
                    onClick={toggleUncategorized}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                  >
                    <span className="inline-block w-3 h-3 rounded-full flex-shrink-0 border border-neutral-300 dark:border-neutral-500" />
                    <span className="flex-1 truncate">Uncategorized</span>
                    {uncategorized && <span className="text-primary-600">✓</span>}
                  </button>
                </li>
              </ul>
            )}
          </div>

          {selectedCount > 0 ? (
            <div className="flex items-center gap-2 flex-wrap">
              {categoryIds.map((id) => {
                const cat = categories.find((c) => c.id === id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: cat?.color ?? FALLBACK_COLOR }}
                  >
                    {cat?.name ?? `#${id}`}
                    <button
                      onClick={() => toggleCategory(id)}
                      aria-label={`Remove ${cat?.name ?? id}`}
                      className="leading-none hover:opacity-80"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              {uncategorized && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200">
                  Uncategorized
                  <button
                    onClick={toggleUncategorized}
                    aria-label="Remove Uncategorized"
                    className="leading-none hover:opacity-80"
                  >
                    ×
                  </button>
                </span>
              )}
              <button
                onClick={resetCategories}
                className="text-xs font-medium text-primary-600 hover:underline"
              >
                All categories
              </button>
            </div>
          ) : (
            <span className="text-xs text-neutral-400">All categories</span>
          )}
        </div>

        {/* Spend over time chart header */}
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm p-5 border border-neutral-100 dark:border-neutral-700">
          <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-neutral-800 dark:text-white">
                Spend over time
              </h2>
              {seriesFetching && (
                <span
                  aria-label="loading chart"
                  className="inline-block w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full animate-spin"
                />
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-neutral-900 dark:text-white">
                {`$${formatCurrency(currentTotal)}`}
              </span>
              {showTrend && (
                <span
                  data-testid="trend-pill"
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                    trendUp
                      ? 'bg-success-50 text-success-600'
                      : 'bg-danger-50 text-danger-600'
                  }`}
                >
                  {trendUp ? '▲' : '▼'}
                  {Math.abs(comparison!.deltaPct ?? 0).toFixed(1)}%
                  <span className="text-neutral-400 font-normal">vs previous {periodNoun}</span>
                </span>
              )}
            </div>
          </div>
          {!series ? (
            <Skeleton className="h-44" />
          ) : seriesAllZero ? (
            <div className="flex flex-col items-center justify-center h-44 gap-2 text-neutral-400">
              <span className="text-3xl">📈</span>
              <span className="text-sm">No spend to chart for this selection</span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={series.data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis
                  dataKey="label"
                  tickFormatter={(label: string) => formatSeriesTick(label, series.granularity)}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis tick={{ fontSize: 11, fill: '#9ca3af' }} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v) => [`$${formatCurrency(Number(v))}`, 'Spend']}
                  contentStyle={{ borderRadius: '8px', fontSize: '12px' }}
                />
                <Bar dataKey="total" fill={chartColor} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-700">
          <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-700 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-neutral-800 dark:text-white">
                {headerLabel}
              </h2>
              {fetching && (
                <span
                  aria-label="loading"
                  className="inline-block w-4 h-4 border-2 border-primary-400 border-t-transparent rounded-full animate-spin"
                />
              )}
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-neutral-500">
                {total} movement{total === 1 ? '' : 's'}
              </span>
              <span className="font-semibold text-neutral-900 dark:text-white">
                {`$${formatCurrency(totalAmount)}`}
              </span>
            </div>
          </div>

          {loading ? (
            <div className="p-5 space-y-3">
              {[...Array(6)].map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : movements.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-neutral-400">
              <span className="text-4xl">🧾</span>
              <span className="text-sm">No movements in this period</span>
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 border-b border-neutral-100 dark:border-neutral-700">
                    <th className="px-5 py-2 font-medium">Date</th>
                    <th className="px-5 py-2 font-medium">Store / Description</th>
                    <th className="px-5 py-2 font-medium">Category</th>
                    <th className="px-5 py-2 font-medium">Payment</th>
                    <th className="px-5 py-2 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr
                      key={m.id}
                      onClick={() => openEditForm(m)}
                      className="border-b border-neutral-50 dark:border-neutral-700/50 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-700/30 transition-colors cursor-pointer"
                    >
                      <td className="px-5 py-3 text-neutral-500 whitespace-nowrap">
                        {formatDate(m.date)}
                        {m.time && (
                          <span className="block text-xs text-neutral-400">{m.time}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-neutral-800 dark:text-neutral-200">
                        {m.store ?? m.description ?? '—'}
                      </td>
                      <td className="px-5 py-3" data-testid={`category-cell-${m.id}`}>
                        {m.category_name ? (
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-medium text-white"
                            style={{ backgroundColor: m.category_color ?? FALLBACK_COLOR }}
                          >
                            {m.category_name}
                          </span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {m.payment_method ? (
                          <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300">
                            {paymentMethodIcon(m.payment_method.kind)} {m.payment_method.name}
                          </span>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right font-semibold text-neutral-900 dark:text-white whitespace-nowrap">
                        {`$${formatCurrency(Number(m.amount))}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {hasMore && (
                <div className="px-5 py-4 flex justify-center border-t border-neutral-100 dark:border-neutral-700">
                  <button
                    onClick={loadMore}
                    className="px-4 py-2 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
                  >
                    Load more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      <MovementForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSaved={handleFormSaved}
        movement={editMovement}
      />
    </>
  );
}
