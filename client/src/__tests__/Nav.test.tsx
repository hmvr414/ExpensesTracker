import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Nav } from '../components/Nav';
import * as gmailApi from '../api/gmail';

vi.mock('../api/gmail', async () => {
  const actual = await vi.importActual<typeof import('../api/gmail')>('../api/gmail');
  return {
    ...actual,
    getGmailPendingCount: vi.fn(),
  };
});

function renderWithRouter(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Nav />
    </MemoryRouter>
  );
}

describe('Nav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.title = 'ExpensesTracker';
    vi.mocked(gmailApi.getGmailPendingCount).mockResolvedValue({ emails: 0, movements: 0 });
  });

  afterEach(() => {
    document.title = 'ExpensesTracker';
  });

  it('renders the app name', () => {
    renderWithRouter();
    expect(screen.getByText('ExpenseTracker')).toBeInTheDocument();
  });

  it('renders links to all routes', () => {
    renderWithRouter();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^movements$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /import/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^categories$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payment methods/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^gmail$/i })).toBeInTheDocument();
  });

  it('movements link points to /movements', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /^movements$/i });
    expect(link).toHaveAttribute('href', '/movements');
  });

  it('dashboard link points to /', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /dashboard/i });
    expect(link).toHaveAttribute('href', '/');
  });

  it('import link points to /import', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /import/i });
    expect(link).toHaveAttribute('href', '/import');
  });

  it('categories link points to /categories', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /^categories$/i });
    expect(link).toHaveAttribute('href', '/categories');
  });

  it('payment methods link points to /payment-methods', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /payment methods/i });
    expect(link).toHaveAttribute('href', '/payment-methods');
  });

  it('gmail link points to /settings/gmail', () => {
    renderWithRouter();
    const link = screen.getByRole('link', { name: /^gmail$/i });
    expect(link).toHaveAttribute('href', '/settings/gmail');
  });

  it('shows the pending movement badge and prefixes the browser title', async () => {
    vi.mocked(gmailApi.getGmailPendingCount).mockResolvedValue({ emails: 2, movements: 3 });
    renderWithRouter();
    expect(await screen.findByLabelText('3 pending movements')).toBeInTheDocument();
    expect(document.title).toBe('(3) ExpensesTracker');
  });

  it('refreshes the pending badge when the Gmail pending refresh event fires', async () => {
    vi.mocked(gmailApi.getGmailPendingCount)
      .mockResolvedValueOnce({ emails: 0, movements: 0 })
      .mockResolvedValueOnce({ emails: 1, movements: 2 });
    renderWithRouter();
    await waitFor(() => {
      expect(gmailApi.getGmailPendingCount).toHaveBeenCalledTimes(1);
    });
    window.dispatchEvent(new Event(gmailApi.GMAIL_PENDING_REFRESH_EVENT));
    expect(await screen.findByLabelText('2 pending movements')).toBeInTheDocument();
    expect(document.title).toBe('(2) ExpensesTracker');
  });
});
