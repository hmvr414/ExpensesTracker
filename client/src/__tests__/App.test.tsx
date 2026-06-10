import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppRoutes } from '../App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  );
}

describe('AppRoutes', () => {
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
});
