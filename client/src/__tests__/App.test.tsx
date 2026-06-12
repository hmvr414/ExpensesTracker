import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../App';

vi.mock('../pages/Dashboard', () => ({
  Dashboard: () => <h1>Dashboard</h1>,
}));

vi.mock('../pages/Import', () => ({
  Import: () => <h1>Import</h1>,
}));

vi.mock('../pages/Categories', () => ({
  Categories: () => <h1>Categories</h1>,
}));

vi.mock('../pages/PaymentMethods', () => ({
  PaymentMethods: () => <h1>Payment Methods</h1>,
}));

vi.mock('../pages/GmailSettings', () => ({
  GmailSettings: () => <h1>Gmail Settings</h1>,
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe('AppRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Dashboard page at /', () => {
    renderAt('/');
    expect(screen.getByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
  });

  it('renders Import page at /import', () => {
    renderAt('/import');
    expect(screen.getByRole('heading', { name: /import/i })).toBeInTheDocument();
  });

  it('renders Categories page at /categories', () => {
    renderAt('/categories');
    expect(screen.getByRole('heading', { name: /categories/i })).toBeInTheDocument();
  });

  it('renders Payment Methods page at /payment-methods', () => {
    renderAt('/payment-methods');
    expect(screen.getByRole('heading', { name: /payment methods/i })).toBeInTheDocument();
  });

  it('renders Gmail Settings page at /settings/gmail', async () => {
    renderAt('/settings/gmail');
    expect(await screen.findByRole('heading', { name: /gmail settings/i })).toBeInTheDocument();
  });
});
