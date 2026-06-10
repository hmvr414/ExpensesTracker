import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Categories } from '../pages/Categories';
import * as categoriesApi from '../api/categories';

vi.mock('../api/categories');

const mockCategories: categoriesApi.Category[] = [
  { id: 1, name: 'Food', color: '#FF5733', icon: '🍔', movement_count: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Transport', color: '#33FF57', icon: null, movement_count: 0, created_at: '2026-01-01T00:00:00Z' },
];

function renderCategories() {
  return render(
    <MemoryRouter>
      <Categories />
    </MemoryRouter>
  );
}

describe('Categories page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton loader while fetching', () => {
    vi.mocked(categoriesApi.getCategories).mockReturnValue(new Promise(() => {}));
    renderCategories();
    expect(screen.getByTestId('categories-skeleton')).toBeInTheDocument();
  });

  it('renders empty state when no categories exist', async () => {
    vi.mocked(categoriesApi.getCategories).mockResolvedValue([]);
    renderCategories();
    await waitFor(() => {
      expect(screen.getByText(/create your first category/i)).toBeInTheDocument();
    });
  });

  it('renders category list with color swatch, name, icon, and movement count', async () => {
    vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
    renderCategories();
    await waitFor(() => {
      expect(screen.getByText('Food')).toBeInTheDocument();
    });
    expect(screen.getByText('Transport')).toBeInTheDocument();
    expect(screen.getByText('🍔')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    const swatches = screen.getAllByTestId('color-swatch');
    expect(swatches[0]).toHaveStyle({ backgroundColor: '#FF5733' });
    expect(swatches[1]).toHaveStyle({ backgroundColor: '#33FF57' });
  });

  describe('Add category form', () => {
    it('renders the add category form at the top', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue([]);
      renderCategories();
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/category name/i)).toBeInTheDocument();
      });
      expect(screen.getByPlaceholderText(/emoji/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add category/i })).toBeInTheDocument();
    });

    it('creates a category when form is submitted with a name', async () => {
      vi.mocked(categoriesApi.getCategories)
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 3, name: 'New Cat', color: '#aabbcc', icon: null, movement_count: 0, created_at: '' }]);
      vi.mocked(categoriesApi.createCategory).mockResolvedValue({
        id: 3, name: 'New Cat', color: '#aabbcc', icon: null, movement_count: 0, created_at: '',
      });
      renderCategories();
      await waitFor(() => screen.getByPlaceholderText(/category name/i));
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText(/category name/i), 'New Cat');
      await user.click(screen.getByRole('button', { name: /add category/i }));
      await waitFor(() => {
        expect(categoriesApi.createCategory).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'New Cat' })
        );
      });
    });

    it('does not submit if name is empty', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue([]);
      renderCategories();
      await waitFor(() => screen.getByRole('button', { name: /add category/i }));
      fireEvent.click(screen.getByRole('button', { name: /add category/i }));
      expect(categoriesApi.createCategory).not.toHaveBeenCalled();
    });

    it('clears the form after successful submission', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue([]);
      vi.mocked(categoriesApi.createCategory).mockResolvedValue({
        id: 3, name: 'Test', color: null, icon: null, movement_count: 0, created_at: '',
      });
      renderCategories();
      await waitFor(() => screen.getByPlaceholderText(/category name/i));
      const user = userEvent.setup();
      const nameInput = screen.getByPlaceholderText(/category name/i);
      await user.type(nameInput, 'Test');
      await user.click(screen.getByRole('button', { name: /add category/i }));
      await waitFor(() => {
        expect(nameInput).toHaveValue('');
      });
    });
  });

  describe('Inline editing', () => {
    it('shows edit button on each category row', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const editButtons = screen.getAllByRole('button', { name: /edit/i });
      expect(editButtons.length).toBeGreaterThanOrEqual(2);
    });

    it('clicking edit replaces text with an input pre-filled with the category name', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /edit/i });
      await user.click(editButtons[0]);
      const editInput = screen.getByDisplayValue('Food');
      expect(editInput).toBeInTheDocument();
    });

    it('saves changes when Enter is pressed', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      vi.mocked(categoriesApi.updateCategory).mockResolvedValue({
        ...mockCategories[0], name: 'Groceries',
      });
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /edit/i });
      await user.click(editButtons[0]);
      const editInput = screen.getByDisplayValue('Food');
      await user.clear(editInput);
      await user.type(editInput, 'Groceries');
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(categoriesApi.updateCategory).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Groceries' }));
      });
    });

    it('saves changes on blur', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      vi.mocked(categoriesApi.updateCategory).mockResolvedValue({
        ...mockCategories[0], name: 'Updated',
      });
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /edit/i });
      await user.click(editButtons[0]);
      const editInput = screen.getByDisplayValue('Food');
      await user.clear(editInput);
      await user.type(editInput, 'Updated');
      fireEvent.blur(editInput);
      await waitFor(() => {
        expect(categoriesApi.updateCategory).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'Updated' }));
      });
    });
  });

  describe('Delete category', () => {
    it('shows delete button on each row', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('delete button is disabled when movement_count > 0', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Food'));
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      expect(deleteButtons[0]).toBeDisabled();
    });

    it('delete button is enabled when movement_count is 0', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Transport'));
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      expect(deleteButtons[1]).not.toBeDisabled();
    });

    it('shows confirmation popover on delete click', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Transport'));
      const user = userEvent.setup();
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      await user.click(deleteButtons[1]);
      expect(screen.getByText(/confirm delete/i)).toBeInTheDocument();
    });

    it('calls deleteCategory when confirmed', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      vi.mocked(categoriesApi.deleteCategory).mockResolvedValue(undefined);
      renderCategories();
      await waitFor(() => screen.getByText('Transport'));
      const user = userEvent.setup();
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      await user.click(deleteButtons[1]);
      const confirmButton = await screen.findByRole('button', { name: /confirm/i });
      await user.click(confirmButton);
      await waitFor(() => {
        expect(categoriesApi.deleteCategory).toHaveBeenCalledWith(2);
      });
    });

    it('cancels deletion when cancel is clicked', async () => {
      vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
      renderCategories();
      await waitFor(() => screen.getByText('Transport'));
      const user = userEvent.setup();
      const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
      await user.click(deleteButtons[1]);
      const cancelButton = await screen.findByRole('button', { name: /cancel/i });
      await user.click(cancelButton);
      expect(categoriesApi.deleteCategory).not.toHaveBeenCalled();
      expect(screen.queryByText(/confirm delete/i)).not.toBeInTheDocument();
    });
  });
});
