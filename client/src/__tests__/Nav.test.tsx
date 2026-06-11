import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Nav } from '../components/Nav';

function renderWithRouter(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Nav />
    </MemoryRouter>
  );
}

describe('Nav', () => {
  it('renders the app name', () => {
    renderWithRouter();
    expect(screen.getByText('ExpenseTracker')).toBeInTheDocument();
  });

  it('renders links to all four routes', () => {
    renderWithRouter();
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /import/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^categories$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payment methods/i })).toBeInTheDocument();
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
});
