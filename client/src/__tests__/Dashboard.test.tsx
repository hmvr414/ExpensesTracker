import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../pages/Dashboard';
import * as dashboardApi from '../api/dashboard';
import * as movementsApi from '../api/movements';
import * as paymentMethodsApi from '../api/paymentMethods';

vi.mock('../api/dashboard');
vi.mock('../api/movements');
vi.mock('../api/paymentMethods');
vi.mock('recharts', () => ({
  PieChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pie-chart">{children}</div>
  ),
  Pie: () => null,
  Cell: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="bar-chart">{children}</div>
  ),
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Legend: () => null,
}));

const mockDashboard = {
  totalAmount: 1500,
  movementCount: 10,
  categoryBreakdown: [
    { categoryId: 1, name: 'Food', color: '#FF5733', total: 800, percentage: 53.3 },
    { categoryId: 2, name: 'Transport', color: '#33FF57', total: 700, percentage: 46.7 },
  ],
  paymentMethodBreakdown: [
    { paymentMethodId: 1, name: 'Cash', kind: 'cash', total: 500, percentage: 33.3 },
    { paymentMethodId: 2, name: 'Visa Platinum', kind: 'card', total: 1000, percentage: 66.7 },
  ],
  timeSeries: [
    { label: 'Jan', total: 500 },
    { label: 'Feb', total: 1000 },
  ],
  previousPeriod: { totalAmount: 1200, movementCount: 8 },
  topStore: 'Walmart',
};

const mockPaymentMethods = [
  { id: 1, name: 'Cash', kind: 'cash' as const, brand: null, variant: null, last4: null, movement_count: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Visa Platinum', kind: 'card' as const, brand: 'visa' as const, variant: 'platinum', last4: '1234', movement_count: 3, created_at: '2026-01-01T00:00:00Z' },
];

const mockMovements = {
  data: [
    {
      id: 1,
      amount: '50.00',
      date: '2026-06-01',
      time: '14:32',
      description: 'Groceries',
      store: 'Walmart',
      category_id: 1,
      category_name: 'Food',
      category_color: '#FF5733',
      payment_method_id: 2,
      payment_method: {
        id: 2,
        name: 'Visa Platinum',
        kind: 'card' as const,
        brand: 'visa' as const,
        variant: 'platinum',
      },
      attachments: [],
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
    },
  ],
  total: 1,
  page: 1,
  limit: 5,
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>
  );
}

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(mockPaymentMethods);
  });

  it('shows skeleton loaders while data is loading', () => {
    vi.mocked(dashboardApi.getDashboard).mockReturnValue(new Promise(() => {}));
    vi.mocked(movementsApi.getMovements).mockReturnValue(new Promise(() => {}));
    renderDashboard();
    const skeletons = document.querySelectorAll('[data-testid="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders stat cards after data loads', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Total Spend')).toBeInTheDocument();
      expect(screen.getByText('Movements')).toBeInTheDocument();
      expect(screen.getByText('Top Category')).toBeInTheDocument();
    });
  });

  it('displays formatted total amount', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/1,500/)).toBeInTheDocument();
    });
  });

  it('displays movement count', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  it('shows up trend indicator when current period is higher than previous', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      const upIndicators = screen.getAllByText('▲');
      expect(upIndicators.length).toBeGreaterThan(0);
    });
  });

  it('shows down trend indicator when current period is lower than previous', async () => {
    const lowerDashboard = {
      ...mockDashboard,
      totalAmount: 900,
      movementCount: 5,
      previousPeriod: { totalAmount: 1200, movementCount: 8 },
    };
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(lowerDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      const downIndicators = screen.getAllByText('▼');
      expect(downIndicators.length).toBeGreaterThan(0);
    });
  });

  it('renders the pie chart for category breakdown', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('pie-chart')).toBeInTheDocument();
    });
  });

  it('renders the bar chart for time series', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getAllByTestId('bar-chart').length).toBeGreaterThan(0);
    });
  });

  it('renders the category breakdown legend with names and percentages', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      // Food appears in legend and possibly in movement badge — use getAllByText
      expect(screen.getAllByText('Food').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Transport').length).toBeGreaterThan(0);
      expect(screen.getByText('53.3%')).toBeInTheDocument();
      expect(screen.getByText('46.7%')).toBeInTheDocument();
    });
  });

  it('renders Recent Movements section heading', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Recent Movements')).toBeInTheDocument();
    });
  });

  it('renders movement rows with store and amount', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      // 'Walmart' appears both in movements list and possibly top store card
      expect(screen.getAllByText('Walmart').length).toBeGreaterThan(0);
      expect(screen.getByText(/50\.00/)).toBeInTheDocument();
    });
  });

  it('shows movement time beside the date when present', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('14:32')).toBeInTheDocument();
    });
  });

  it('shows empty state when there are no movements at all', async () => {
    const emptyDashboard = {
      ...mockDashboard,
      totalAmount: 0,
      movementCount: 0,
      categoryBreakdown: [],
      timeSeries: [],
      previousPeriod: { totalAmount: 0, movementCount: 0 },
      topStore: null,
    };
    const emptyMovements = { data: [], total: 0, page: 1, limit: 5 };
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(emptyDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(emptyMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText(/no expenses yet/i)).toBeInTheDocument();
      expect(screen.getByText(/add your first expense/i)).toBeInTheDocument();
    });
  });

  // --- Payment methods ---

  it('shows a payment method badge on movement rows that have one', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByTestId('pm-badge')).toHaveTextContent('Visa Platinum');
    });
  });

  it('omits the payment method badge when the movement has none', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue({
      ...mockMovements,
      data: [
        { ...mockMovements.data[0], payment_method_id: null, payment_method: null },
      ],
    });
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Recent Movements')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('pm-badge')).not.toBeInTheDocument();
  });

  it('renders a payment method filter populated from getPaymentMethods', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      const filter = screen.getByLabelText(/filter by payment method/i);
      expect(filter).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /all payment methods/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: '💵 Cash' })).toBeInTheDocument();
    });
  });

  it('refetches movements with payment_method_id when the filter changes', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByLabelText(/filter by payment method/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/filter by payment method/i), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(movementsApi.getMovements).toHaveBeenCalledWith(
        expect.objectContaining({ payment_method_id: 2 })
      );
    });
  });

  it('clears the payment_method_id param when the filter is reset to All', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByLabelText(/filter by payment method/i)).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/filter by payment method/i), {
      target: { value: '2' },
    });
    await waitFor(() => {
      expect(movementsApi.getMovements).toHaveBeenCalledWith(
        expect.objectContaining({ payment_method_id: 2 })
      );
    });
    fireEvent.change(screen.getByLabelText(/filter by payment method/i), {
      target: { value: '' },
    });
    await waitFor(() => {
      const calls = vi.mocked(movementsApi.getMovements).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall).not.toHaveProperty('payment_method_id');
    });
  });

  it('renders the Spend by Payment Method section when breakdown has data', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Spend by Payment Method')).toBeInTheDocument();
    });
  });

  it('hides the Spend by Payment Method section when breakdown is empty', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue({
      ...mockDashboard,
      paymentMethodBreakdown: [],
    });
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Spend by Category')).toBeInTheDocument();
    });
    expect(screen.queryByText('Spend by Payment Method')).not.toBeInTheDocument();
  });

  it('shows top store in stat card', async () => {
    vi.mocked(dashboardApi.getDashboard).mockResolvedValue(mockDashboard);
    vi.mocked(movementsApi.getMovements).mockResolvedValue(mockMovements);
    renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Top Store')).toBeInTheDocument();
      expect(screen.getAllByText('Walmart').length).toBeGreaterThan(0);
    });
  });
});
