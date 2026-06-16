import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Movements, formatSeriesTick } from '../pages/Movements';
import * as movementsApi from '../api/movements';
import * as categoriesApi from '../api/categories';

vi.mock('../api/movements');
vi.mock('../api/categories');
// MovementForm pulls in categories/payment-methods/attachments APIs; stub it so
// these tests focus on the page behavior.
vi.mock('../components/MovementForm', () => ({
  MovementForm: ({ open, movement }: { open: boolean; movement?: { id: number } }) =>
    open ? <div data-testid="movement-form">editing:{movement ? movement.id : 'new'}</div> : null,
}));
// Stub recharts so we can inspect the data/fill the chart receives in jsdom.
vi.mock('recharts', () => ({
  BarChart: ({ children, data }: { children: React.ReactNode; data: unknown }) => (
    <div data-testid="series-chart" data-points={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Bar: ({ fill }: { fill: string }) => <div data-testid="series-bar" data-fill={fill} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const mockCategories: categoriesApi.Category[] = [
  { id: 1, name: 'Food', color: '#FF5733', icon: null, movement_count: 5, created_at: '' },
  { id: 2, name: 'Transport', color: '#3366FF', icon: null, movement_count: 3, created_at: '' },
];

const mockSeries = (
  over: Partial<movementsApi.MovementsSeriesResponse> = {}
): movementsApi.MovementsSeriesResponse => ({
  granularity: 'day',
  data: [
    { label: '2026-06-01', total: 40 },
    { label: '2026-06-02', total: 60 },
  ],
  comparison: { previousTotal: 100, currentTotal: 150, deltaPct: 50 },
  ...over,
});

const mockMovement = (over: Partial<movementsApi.Movement> = {}): movementsApi.Movement => ({
  id: 1,
  amount: '50.00',
  date: '2026-06-10',
  time: '14:32',
  description: 'Groceries',
  store: 'Walmart',
  category_id: 1,
  category_name: 'Food',
  category_color: '#FF5733',
  payment_method_id: 2,
  payment_method: { id: 2, name: 'Visa Platinum', kind: 'card', brand: 'visa', variant: 'platinum' },
  attachments: [],
  created_at: '2026-06-10T00:00:00Z',
  updated_at: '2026-06-10T00:00:00Z',
  ...over,
});

function mockList(over: Partial<movementsApi.MovementsResponse> = {}) {
  const data = over.data ?? [mockMovement()];
  return {
    data,
    total: over.total ?? data.length,
    totalAmount: over.totalAmount ?? data.reduce((s, m) => s + Number(m.amount), 0),
    page: over.page ?? 1,
    limit: over.limit ?? 50,
  };
}

function renderMovements(initialEntries: string[] = ['/movements']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Movements />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(new Date('2026-06-16T12:00:00Z'));
  vi.mocked(movementsApi.getMovements).mockResolvedValue(mockList());
  vi.mocked(movementsApi.getMovementsSeries).mockResolvedValue(mockSeries());
  vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
});

describe('Movements page', () => {
  it('defaults to the current month and fetches that range', async () => {
    renderMovements();
    await waitFor(() => expect(movementsApi.getMovements).toHaveBeenCalled());
    const params = vi.mocked(movementsApi.getMovements).mock.calls[0][0];
    expect(params).toMatchObject({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('renders the table columns including time and amount', async () => {
    renderMovements();
    const row = (await screen.findByText('Walmart')).closest('tr')!;
    expect(within(row).getByText('Food')).toBeInTheDocument();
    expect(within(row).getByText(/Visa Platinum/)).toBeInTheDocument();
    expect(within(row).getByText('14:32')).toBeInTheDocument();
    expect(within(row).getByText('$50.00')).toBeInTheDocument();
  });

  it('shows an em-dash category for uncategorized rows', async () => {
    vi.mocked(movementsApi.getMovements).mockResolvedValue(
      mockList({
        data: [
          mockMovement({ id: 9, category_id: null, category_name: null, category_color: null }),
        ],
      })
    );
    renderMovements();
    await screen.findByText('Walmart');
    expect(screen.getByTestId('category-cell-9')).toHaveTextContent('—');
  });

  it('shows the period label, count and totalAmount in the header', async () => {
    vi.mocked(movementsApi.getMovements).mockResolvedValue(
      mockList({ total: 12, totalAmount: 1234.5 })
    );
    renderMovements();
    // The period label shows in both the nav control and the table header row.
    expect((await screen.findAllByText('June 2026')).length).toBeGreaterThan(0);
    expect(screen.getByText(/12 movements/)).toBeInTheDocument();
    expect(screen.getByText('$1,234.50')).toBeInTheDocument();
  });

  it('maps Day/Week/Month chips to the right from/to', async () => {
    renderMovements();
    await waitFor(() => expect(movementsApi.getMovements).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Day' }));
    await waitFor(() => {
      const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(last).toMatchObject({ from: '2026-06-16', to: '2026-06-16' });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    await waitFor(() => {
      const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      // Week containing Tue 2026-06-16 → Mon 06-15 .. Sun 06-21
      expect(last).toMatchObject({ from: '2026-06-15', to: '2026-06-21' });
    });
  });

  it('navigates periods with the ‹ › controls', async () => {
    renderMovements(['/movements?period=month&anchor=2026-06-16']);
    await waitFor(() => expect(movementsApi.getMovements).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    await waitFor(() => {
      const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(last).toMatchObject({ from: '2026-05-01', to: '2026-05-31' });
    });
  });

  it('supports a custom range with from ≤ to validation', async () => {
    renderMovements();
    await waitFor(() => expect(movementsApi.getMovements).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));

    const fromInput = screen.getByLabelText('From date');
    const toInput = screen.getByLabelText('To date');
    fireEvent.change(fromInput, { target: { value: '2026-03-10' } });
    fireEvent.change(toInput, { target: { value: '2026-03-01' } });

    expect(screen.getByText(/from.*before.*to|invalid range/i)).toBeInTheDocument();

    fireEvent.change(toInput, { target: { value: '2026-03-20' } });
    await waitFor(() => {
      const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(last).toMatchObject({ from: '2026-03-10', to: '2026-03-20' });
    });
  });

  it('round-trips the view through URL params', async () => {
    renderMovements(['/movements?from=2026-02-01&to=2026-02-28']);
    await waitFor(() => {
      const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(last).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    });
    expect((screen.getByLabelText('From date') as HTMLInputElement).value).toBe('2026-02-01');
  });

  it('opens the edit form on row click', async () => {
    renderMovements();
    const row = await screen.findByText('Walmart');
    fireEvent.click(row);
    expect(await screen.findByTestId('movement-form')).toHaveTextContent('editing:1');
  });

  it('shows an empty state when there are no movements', async () => {
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockList({ data: [], total: 0 }));
    renderMovements();
    expect(await screen.findByText(/No movements in this period/i)).toBeInTheDocument();
  });

  it('appends more rows when Load more is clicked', async () => {
    vi.mocked(movementsApi.getMovements).mockResolvedValue(
      mockList({ data: [mockMovement({ id: 1, store: 'Walmart' })], total: 3 })
    );
    renderMovements();
    await screen.findByText('Walmart');

    vi.mocked(movementsApi.getMovements).mockResolvedValue(
      mockList({
        data: [
          mockMovement({ id: 1, store: 'Walmart' }),
          mockMovement({ id: 2, store: 'Target' }),
          mockMovement({ id: 3, store: 'Costco' }),
        ],
        total: 3,
      })
    );
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await screen.findByText('Costco');
    const last = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
    expect(last!.limit).toBeGreaterThan(50);
  });
});

describe('Movements category filter & spend-over-time chart', () => {
  it('fetches the series for the active range and renders the chart', async () => {
    renderMovements();
    await waitFor(() => expect(movementsApi.getMovementsSeries).toHaveBeenCalled());
    const params = vi.mocked(movementsApi.getMovementsSeries).mock.calls[0][0];
    expect(params).toMatchObject({ from: '2026-06-01', to: '2026-06-30' });
    expect(await screen.findByTestId('series-chart')).toBeInTheDocument();
  });

  it('shows the current total and an up trend pill from deltaPct', async () => {
    renderMovements();
    const pill = await screen.findByTestId('trend-pill');
    expect(pill).toHaveTextContent('▲');
    expect(pill).toHaveTextContent('50');
    expect(pill).toHaveTextContent(/vs previous month/i);
  });

  it('shows a down trend pill when spend decreased', async () => {
    vi.mocked(movementsApi.getMovementsSeries).mockResolvedValue(
      mockSeries({ comparison: { previousTotal: 200, currentTotal: 150, deltaPct: -25 } })
    );
    renderMovements();
    const pill = await screen.findByTestId('trend-pill');
    expect(pill).toHaveTextContent('▼');
    expect(pill).toHaveTextContent('25');
  });

  it('hides the trend pill when there is no previous period (delta null)', async () => {
    vi.mocked(movementsApi.getMovementsSeries).mockResolvedValue(
      mockSeries({ comparison: { previousTotal: 0, currentTotal: 150, deltaPct: null } })
    );
    renderMovements();
    await screen.findByTestId('series-chart');
    expect(screen.queryByTestId('trend-pill')).not.toBeInTheDocument();
  });

  it('renders an empty chart state when the series is all zeros', async () => {
    vi.mocked(movementsApi.getMovementsSeries).mockResolvedValue(
      mockSeries({
        data: [
          { label: '2026-06-01', total: 0 },
          { label: '2026-06-02', total: 0 },
        ],
        comparison: { previousTotal: 0, currentTotal: 0, deltaPct: null },
      })
    );
    renderMovements();
    expect(await screen.findByText(/No spend to chart/i)).toBeInTheDocument();
  });

  it('toggling a category updates category_id in both list and series calls and the URL', async () => {
    renderMovements();
    await screen.findByText('Walmart');

    fireEvent.click(screen.getByRole('button', { name: /categories/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Food/ }));

    await waitFor(() => {
      const list = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(list!.category_id).toEqual([1]);
    });
    const series = vi.mocked(movementsApi.getMovementsSeries).mock.calls.slice(-1)[0][0];
    expect(series.category_id).toEqual([1]);
  });

  it('colors the chart with the single selected category color', async () => {
    renderMovements(['/movements?period=month&anchor=2026-06-16&category_id=1']);
    const bar = await screen.findByTestId('series-bar');
    expect(bar).toHaveAttribute('data-fill', '#FF5733');
  });

  it('uses the primary color when multiple categories are selected', async () => {
    renderMovements(['/movements?period=month&anchor=2026-06-16&category_id=1&category_id=2']);
    const bar = await screen.findByTestId('series-bar');
    expect(bar).toHaveAttribute('data-fill', '#6366f1');
  });

  it('resets the selection with All categories', async () => {
    renderMovements(['/movements?period=month&anchor=2026-06-16&category_id=1']);
    await screen.findByText('Walmart');

    fireEvent.click(await screen.findByRole('button', { name: /All categories/i }));
    await waitFor(() => {
      const list = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(list!.category_id).toBeUndefined();
    });
  });

  it('removes a single category via its chip', async () => {
    renderMovements(['/movements?period=month&anchor=2026-06-16&category_id=1&category_id=2']);
    await screen.findByText('Walmart');

    fireEvent.click(await screen.findByRole('button', { name: /Remove Food/i }));
    await waitFor(() => {
      const list = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
      expect(list!.category_id).toEqual([2]);
    });
  });

  it('toggles the Uncategorized pseudo-option into the filter', async () => {
    renderMovements();
    await screen.findByText('Walmart');

    fireEvent.click(screen.getByRole('button', { name: /categories/i }));
    fireEvent.click(await screen.findByRole('option', { name: /Uncategorized/i }));

    await waitFor(() => {
      const series = vi.mocked(movementsApi.getMovementsSeries).mock.calls.slice(-1)[0][0];
      expect(series.uncategorized).toBe(true);
    });
    const list = vi.mocked(movementsApi.getMovements).mock.calls.slice(-1)[0][0];
    expect(list!.uncategorized).toBe(true);
  });
});

describe('formatSeriesTick', () => {
  it('shortens daily/weekly ISO labels to MM/DD', () => {
    expect(formatSeriesTick('2026-06-09', 'day')).toBe('06/09');
    expect(formatSeriesTick('2026-06-09', 'week')).toBe('06/09');
  });
  it('passes hourly and monthly labels through unchanged', () => {
    expect(formatSeriesTick('14:00', 'hour')).toBe('14:00');
    expect(formatSeriesTick('Jun 2026', 'month')).toBe('Jun 2026');
  });
});
