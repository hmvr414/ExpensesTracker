import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import { getDashboard, DashboardData, DashboardPeriod } from '../api/dashboard';
import { getMovements, Movement, GetMovementsParams } from '../api/movements';
import { getPaymentMethods, PaymentMethod } from '../api/paymentMethods';
import { paymentMethodIcon } from '../helpers/paymentMethod';
import { PeriodSelector } from '../components/PeriodSelector';
import { MovementForm } from '../components/MovementForm';

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      data-testid="skeleton"
      className={`animate-pulse bg-neutral-200 dark:bg-neutral-700 rounded ${className}`}
    />
  );
}

function TrendIndicator({ current, previous }: { current: number; previous: number }) {
  if (previous === 0) return null;
  return current >= previous ? (
    <span className="text-success-600 text-sm font-medium">▲</span>
  ) : (
    <span className="text-danger-600 text-sm font-medium">▼</span>
  );
}

function StatCard({
  label,
  value,
  trend,
}: {
  label: string;
  value: string;
  trend?: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm p-5 flex flex-col gap-1 border border-neutral-100 dark:border-neutral-700">
      <span className="text-xs font-medium text-neutral-500 uppercase tracking-wide">{label}</span>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-neutral-900 dark:text-white">{value}</span>
        {trend}
      </div>
    </div>
  );
}

function formatCurrency(amount: number) {
  return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const FALLBACK_COLOR = '#6366f1';

export function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = (searchParams.get('period') as DashboardPeriod) ?? 'month';
  const anchor = searchParams.get('anchor') ?? new Date().toISOString().split('T')[0];

  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [movements, setMovements] = useState<Movement[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [pmFilter, setPmFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const isFirstLoad = useRef(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editMovement, setEditMovement] = useState<Movement | undefined>(undefined);

  useEffect(() => {
    getPaymentMethods().then(setPaymentMethods).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!isFirstLoad.current) {
      setFetching(true);
    }
    const movementParams: GetMovementsParams = { limit: 5 };
    if (pmFilter != null) movementParams.payment_method_id = pmFilter;
    Promise.all([getDashboard({ period, anchor }), getMovements(movementParams)]).then(
      ([dash, mov]) => {
        if (cancelled) return;
        setDashboard(dash);
        setMovements(mov.data);
        isFirstLoad.current = false;
        setLoading(false);
        setFetching(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [period, anchor, refreshKey, pmFilter]);

  function handlePeriodChange(newPeriod: DashboardPeriod, newAnchor: string) {
    setSearchParams({ period: newPeriod, anchor: newAnchor });
  }

  function openAddForm() {
    setEditMovement(undefined);
    setFormOpen(true);
  }

  function openEditForm(m: Movement) {
    setEditMovement(m);
    setFormOpen(true);
  }

  function handleFormSaved() {
    setRefreshKey((k) => k + 1);
  }

  if (loading) {
    return (
      <main className="flex-1 overflow-y-auto p-6 space-y-6">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Dashboard</h1>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
        <Skeleton className="h-48" />
      </main>
    );
  }

  const totalNow = dashboard!.totalAmount;
  const totalPrev = dashboard!.previousPeriod.totalAmount;
  const countNow = dashboard!.movementCount;
  const countPrev = dashboard!.previousPeriod.movementCount;
  const topCategory = dashboard!.categoryBreakdown[0];
  const topStore = dashboard!.topStore;
  const isEmpty = countNow === 0 && movements.length === 0;

  if (isEmpty) {
    return (
      <>
        <main className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center gap-4">
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Dashboard</h1>
          <div className="text-center space-y-3">
            <div className="text-5xl">📊</div>
            <h2 className="text-xl font-semibold text-neutral-700 dark:text-neutral-300">
              No expenses yet
            </h2>
            <p className="text-neutral-500">
              Start tracking your spending by adding your first expense.
            </p>
            <button
              onClick={openAddForm}
              className="mt-2 px-5 py-2 bg-primary-600 text-white rounded-lg font-medium hover:bg-primary-700 transition-colors"
            >
              Add your first expense
            </button>
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

  return (
    <>
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Dashboard</h1>
        <div className="flex items-center gap-3">
          <PeriodSelector
            period={period}
            anchor={anchor}
            onPeriodChange={handlePeriodChange}
            loading={fetching}
          />
          <button
            onClick={openAddForm}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors whitespace-nowrap"
          >
            + Add Expense
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Total Spend"
          value={`$${formatCurrency(totalNow)}`}
          trend={<TrendIndicator current={totalNow} previous={totalPrev} />}
        />
        <StatCard
          label="Movements"
          value={String(countNow)}
          trend={<TrendIndicator current={countNow} previous={countPrev} />}
        />
        <StatCard
          label="Top Category"
          value={topCategory ? topCategory.name : '—'}
        />
        <StatCard
          label="Top Store"
          value={topStore ?? '—'}
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Donut / pie chart */}
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm p-5 border border-neutral-100 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-white mb-4">
            Spend by Category
          </h2>
          {dashboard!.categoryBreakdown.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2 text-neutral-400">
              <span className="text-3xl">🍩</span>
              <span className="text-sm">No data for this period</span>
            </div>
          ) : (
            <div className="flex gap-4 items-center">
              <ResponsiveContainer width={180} height={180}>
                <PieChart>
                  <Pie
                    data={dashboard!.categoryBreakdown}
                    dataKey="total"
                    nameKey="name"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={2}
                  >
                    {dashboard!.categoryBreakdown.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color ?? FALLBACK_COLOR} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
              <ul className="flex-1 space-y-2 text-sm">
                {dashboard!.categoryBreakdown.map((entry) => (
                  <li key={entry.categoryId ?? entry.name} className="flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                      style={{ backgroundColor: entry.color ?? FALLBACK_COLOR }}
                    />
                    <span className="flex-1 text-neutral-700 dark:text-neutral-300 truncate">
                      {entry.name}
                    </span>
                    <span className="text-neutral-500 font-medium">{entry.percentage}%</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Payment method bar chart — sits under the category donut in the grid */}
        {dashboard!.paymentMethodBreakdown.length > 0 && (
          <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm p-5 border border-neutral-100 dark:border-neutral-700 lg:order-last">
            <h2 className="text-base font-semibold text-neutral-800 dark:text-white mb-4">
              Spend by Payment Method
            </h2>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart
                data={dashboard!.paymentMethodBreakdown}
                layout="vertical"
                margin={{ top: 4, right: 4, left: 8, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e5e7eb" />
                <XAxis
                  type="number"
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={110}
                  tick={{ fontSize: 11, fill: '#9ca3af' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(v) => [`$${formatCurrency(Number(v))}`, 'Spend']}
                  contentStyle={{ borderRadius: '8px', fontSize: '12px' }}
                />
                <Bar dataKey="total" fill="#6366f1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Bar chart */}
        <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm p-5 border border-neutral-100 dark:border-neutral-700">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-white mb-4">
            Spend Over Time
          </h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dashboard!.timeSeries} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                formatter={(v) => [`$${formatCurrency(Number(v))}`, 'Spend']}
                contentStyle={{ borderRadius: '8px', fontSize: '12px' }}
              />
              <Bar dataKey="total" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Movements */}
      <div className="bg-white dark:bg-neutral-800 rounded-xl shadow-sm border border-neutral-100 dark:border-neutral-700">
        <div className="px-5 py-4 border-b border-neutral-100 dark:border-neutral-700 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-neutral-800 dark:text-white">
            Recent Movements
          </h2>
          <select
            aria-label="Filter by payment method"
            value={pmFilter ?? ''}
            onChange={(e) => setPmFilter(e.target.value ? Number(e.target.value) : null)}
            className="rounded-lg border border-neutral-300 dark:border-neutral-600 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-200"
          >
            <option value="">All payment methods</option>
            {paymentMethods.map((pm) => (
              <option key={pm.id} value={pm.id}>
                {paymentMethodIcon(pm.kind)} {pm.name}
              </option>
            ))}
          </select>
        </div>
        <ul>
          {movements.map((m) => (
            <li
              key={m.id}
              onClick={() => openEditForm(m)}
              className="flex items-center gap-4 px-5 py-3 border-b border-neutral-50 dark:border-neutral-700/50 last:border-0 hover:bg-neutral-50 dark:hover:bg-neutral-700/30 transition-colors cursor-pointer"
            >
              <span className="text-xs text-neutral-500 w-20 flex-shrink-0">
                {formatDate(m.date)}
                {m.time && <span className="block">{m.time}</span>}
              </span>
              <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-200 truncate">
                {m.store ?? m.description ?? '—'}
              </span>
              {m.category_name && (
                <span
                  className="px-2 py-0.5 rounded-full text-xs font-medium text-white flex-shrink-0"
                  style={{ backgroundColor: m.category_color ?? FALLBACK_COLOR }}
                >
                  {m.category_name}
                </span>
              )}
              {m.payment_method && (
                <span
                  data-testid="pm-badge"
                  className="px-2 py-0.5 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 flex-shrink-0"
                >
                  {paymentMethodIcon(m.payment_method.kind)} {m.payment_method.name}
                </span>
              )}
              <span className="text-sm font-semibold text-neutral-900 dark:text-white w-20 text-right flex-shrink-0">
                ${m.amount}
              </span>
            </li>
          ))}
        </ul>
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
