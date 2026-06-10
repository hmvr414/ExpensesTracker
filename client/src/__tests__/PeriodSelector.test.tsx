import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  PeriodSelector,
  getPeriodLabel,
  navigatePeriod,
  isNextDisabled,
} from '../components/PeriodSelector';
import type { DashboardPeriod } from '../api/dashboard';

describe('getPeriodLabel', () => {
  it('formats month label', () => {
    expect(getPeriodLabel('month', '2026-06-09')).toBe('June 2026');
  });

  it('formats day label', () => {
    expect(getPeriodLabel('day', '2026-06-09')).toBe('Tuesday Jun 9');
  });

  it('formats week label same month', () => {
    const label = getPeriodLabel('week', '2026-06-09');
    expect(label).toMatch(/^Week of Jun \d+–\d+$/);
  });

  it('formats year label', () => {
    expect(getPeriodLabel('year', '2026-06-09')).toBe('2026');
  });

  it('formats all label', () => {
    expect(getPeriodLabel('all', '2026-06-09')).toBe('All Time');
  });
});

describe('navigatePeriod', () => {
  it('advances day by 1 on next', () => {
    expect(navigatePeriod('day', '2026-06-09', 'next')).toBe('2026-06-10');
  });

  it('retreats day by 1 on prev', () => {
    expect(navigatePeriod('day', '2026-06-09', 'prev')).toBe('2026-06-08');
  });

  it('advances week by 7 days on next', () => {
    expect(navigatePeriod('week', '2026-06-09', 'next')).toBe('2026-06-16');
  });

  it('retreats week by 7 days on prev', () => {
    expect(navigatePeriod('week', '2026-06-09', 'prev')).toBe('2026-06-02');
  });

  it('advances month on next', () => {
    expect(navigatePeriod('month', '2026-06-09', 'next')).toBe('2026-07-09');
  });

  it('retreats month on prev', () => {
    expect(navigatePeriod('month', '2026-06-09', 'prev')).toBe('2026-05-09');
  });

  it('advances year on next', () => {
    expect(navigatePeriod('year', '2026-06-09', 'next')).toBe('2027-06-09');
  });

  it('retreats year on prev', () => {
    expect(navigatePeriod('year', '2026-06-09', 'prev')).toBe('2025-06-09');
  });
});

describe('isNextDisabled', () => {
  it('disables next for day when anchor is today', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(isNextDisabled('day', today)).toBe(true);
  });

  it('enables next for day when anchor is in the past', () => {
    expect(isNextDisabled('day', '2020-01-01')).toBe(false);
  });

  it('disables next for month when anchor is current month', () => {
    const today = new Date();
    const anchor = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    expect(isNextDisabled('month', anchor)).toBe(true);
  });

  it('enables next for month when anchor is a past month', () => {
    expect(isNextDisabled('month', '2020-01-01')).toBe(false);
  });

  it('disables next for year when anchor is current year', () => {
    const anchor = `${new Date().getFullYear()}-01-01`;
    expect(isNextDisabled('year', anchor)).toBe(true);
  });

  it('disables next for all period', () => {
    expect(isNextDisabled('all', '2026-06-09')).toBe(true);
  });
});

describe('PeriodSelector', () => {
  const mockOnChange = vi.fn();
  const defaultProps = {
    period: 'month' as DashboardPeriod,
    anchor: '2026-06-09',
    onPeriodChange: mockOnChange,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all 5 period tabs', () => {
    render(<PeriodSelector {...defaultProps} />);
    expect(screen.getByText('Day')).toBeInTheDocument();
    expect(screen.getByText('Week')).toBeInTheDocument();
    expect(screen.getByText('Month')).toBeInTheDocument();
    expect(screen.getByText('Year')).toBeInTheDocument();
    expect(screen.getByText('All')).toBeInTheDocument();
  });

  it('marks the active period tab with aria-pressed=true', () => {
    render(<PeriodSelector {...defaultProps} />);
    expect(screen.getByText('Month')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Day')).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a period tab calls onPeriodChange immediately', () => {
    render(<PeriodSelector {...defaultProps} />);
    fireEvent.click(screen.getByText('Day'));
    expect(mockOnChange).toHaveBeenCalledWith('day', '2026-06-09');
  });

  it('renders prev and next buttons for non-all periods', () => {
    render(<PeriodSelector {...defaultProps} />);
    expect(screen.getByLabelText('Previous period')).toBeInTheDocument();
    expect(screen.getByLabelText('Next period')).toBeInTheDocument();
  });

  it('does not render prev/next buttons for all period', () => {
    render(<PeriodSelector {...defaultProps} period="all" />);
    expect(screen.queryByLabelText('Previous period')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Next period')).not.toBeInTheDocument();
  });

  it('renders human-readable month label', () => {
    render(<PeriodSelector {...defaultProps} />);
    expect(screen.getByText('June 2026')).toBeInTheDocument();
  });

  it('next button is disabled when anchor is the current month', () => {
    const today = new Date();
    const anchor = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    render(<PeriodSelector {...defaultProps} anchor={anchor} />);
    expect(screen.getByLabelText('Next period')).toBeDisabled();
  });

  it('prev button is always enabled for non-all periods', () => {
    render(<PeriodSelector {...defaultProps} />);
    expect(screen.getByLabelText('Previous period')).not.toBeDisabled();
  });

  it('clicking next calls onPeriodChange after debounce', async () => {
    vi.useFakeTimers();
    render(<PeriodSelector {...defaultProps} anchor="2026-05-09" />);
    fireEvent.click(screen.getByLabelText('Next period'));
    expect(mockOnChange).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(mockOnChange).toHaveBeenCalledWith('month', '2026-06-09');
    vi.useRealTimers();
  });

  it('clicking prev calls onPeriodChange after debounce', async () => {
    vi.useFakeTimers();
    render(<PeriodSelector {...defaultProps} />);
    fireEvent.click(screen.getByLabelText('Previous period'));
    act(() => {
      vi.runAllTimers();
    });
    expect(mockOnChange).toHaveBeenCalledWith('month', '2026-05-09');
    vi.useRealTimers();
  });

  it('rapid clicks are debounced — only last navigation fires', async () => {
    vi.useFakeTimers();
    render(<PeriodSelector {...defaultProps} anchor="2026-03-09" />);
    fireEvent.click(screen.getByLabelText('Next period'));
    fireEvent.click(screen.getByLabelText('Next period'));
    fireEvent.click(screen.getByLabelText('Next period'));
    act(() => {
      vi.runAllTimers();
    });
    expect(mockOnChange).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('shows loading spinner in label area when loading prop is true', () => {
    render(<PeriodSelector {...defaultProps} loading={true} />);
    expect(screen.getByLabelText('loading')).toBeInTheDocument();
    expect(screen.queryByText('June 2026')).not.toBeInTheDocument();
  });

  it('shows label text when loading is false', () => {
    render(<PeriodSelector {...defaultProps} loading={false} />);
    expect(screen.queryByLabelText('loading')).not.toBeInTheDocument();
    expect(screen.getByText('June 2026')).toBeInTheDocument();
  });
});
