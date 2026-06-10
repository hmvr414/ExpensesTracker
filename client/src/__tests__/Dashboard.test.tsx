import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '../pages/Dashboard';
import * as dashboardApi from '../api/dashboard';
import * as movementsApi from '../api/movements';

vi.mock('../api/dashboard');
vi.mock('../api/movements');
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
  timeSeries: [
    { label: 'Jan', total: 500 },
    { label: 'Feb', total: 1000 },
  ],
  previousPeriod: { totalAmount: 1200, movementCount: 8 },
  topStore: 'Walmart',
};

const mockMovements = {
  data: [
    {
      id: 1,
      amount: '50.00',
      date: '2026-06-01',
      description: 'Groceries',
      store: 'Walmart',
      category_id: 1,
      category_name: 'Food',
      category_color: '#FF5733',
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
      expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
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
