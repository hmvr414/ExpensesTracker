import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MovementForm } from '../components/MovementForm';
import * as categoriesApi from '../api/categories';
import * as movementsApi from '../api/movements';
import * as attachmentsApi from '../api/attachments';
import * as suggestApi from '../api/suggest';

vi.mock('../api/categories');
vi.mock('../api/movements');
vi.mock('../api/attachments');
vi.mock('../api/suggest');

const mockCategories = [
  { id: 1, name: 'Food', color: '#FF5733', icon: null, movement_count: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Transport', color: '#33FF57', icon: null, movement_count: 3, created_at: '2026-01-01T00:00:00Z' },
];

const mockCreatedMovement = {
  id: 99,
  amount: '50.00',
  date: '2026-06-09',
  description: null,
  store: null,
  category_id: null,
  category_name: null,
  category_color: null,
  attachments: [],
  created_at: '2026-06-09T00:00:00Z',
  updated_at: '2026-06-09T00:00:00Z',
};

const mockExistingMovement = {
  id: 42,
  amount: '99.99',
  date: '2026-06-01',
  description: 'Test description',
  store: 'TestStore',
  category_id: 1,
  category_name: 'Food',
  category_color: '#FF5733',
  attachments: [
    {
      id: 10,
      file_name: 'receipt.jpg',
      file_path: '/uploads/2026-06/receipt.jpg',
      mime_type: 'image/jpeg',
      url: '/uploads/2026-06/receipt.jpg',
      created_at: '2026-06-01T00:00:00Z',
    },
  ],
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const mockAttachmentResponse = {
  id: 20,
  movement_id: 99,
  file_name: 'test.jpg',
  file_path: '/uploads/2026-06/test.jpg',
  mime_type: 'image/jpeg',
  url: '/uploads/2026-06/test.jpg',
  created_at: '2026-06-09T00:00:00Z',
};

function renderForm(props: Partial<React.ComponentProps<typeof MovementForm>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <MovementForm
      open={props.open ?? true}
      onClose={props.onClose ?? onClose}
      onSaved={props.onSaved ?? onSaved}
      movement={props.movement}
    />
  );
  return { onClose, onSaved };
}

describe('MovementForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
    vi.mocked(suggestApi.suggestCategory).mockResolvedValue({ categoryId: null });
    vi.mocked(movementsApi.createMovement).mockResolvedValue(mockCreatedMovement);
    vi.mocked(movementsApi.updateMovement).mockResolvedValue({ ...mockExistingMovement });
    vi.mocked(attachmentsApi.createAttachment).mockResolvedValue(mockAttachmentResponse);
    vi.mocked(attachmentsApi.deleteAttachment).mockResolvedValue(undefined);
  });

  // --- Rendering ---

  it('does not render when open is false', () => {
    renderForm({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the panel with "Add Expense" title when open', () => {
    renderForm({ open: true });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /add expense/i })).toBeInTheDocument();
  });

  it('renders core form fields', () => {
    renderForm();
    expect(screen.getByPlaceholderText('0.00')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Walmart')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Weekly groceries')).toBeInTheDocument();
  });

  // --- Close behavior ---

  it('calls onClose when X button is clicked', () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onClose when overlay is clicked', () => {
    const { onClose } = renderForm();
    fireEvent.click(screen.getByTestId('form-overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // --- Category loading ---

  it('fetches categories when opened', async () => {
    renderForm({ open: true });
    await waitFor(() => {
      expect(categoriesApi.getCategories).toHaveBeenCalledOnce();
    });
  });

  it('populates category select with fetched categories', async () => {
    renderForm({ open: true });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Food' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Transport' })).toBeInTheDocument();
    });
  });

  // --- Validation ---

  it('shows error when amount is empty on submit', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(screen.getByText(/amount must be a positive number/i)).toBeInTheDocument();
    });
  });

  it('shows error when date is cleared on submit', async () => {
    renderForm();
    const dateInput = screen.getByLabelText(/date/i);
    fireEvent.change(dateInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(screen.getByText(/valid date/i)).toBeInTheDocument();
    });
  });

  // --- Submit: create mode ---

  it('calls createMovement with correct data on valid submit', async () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50.00' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. Walmart'), { target: { value: 'Costco' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(movementsApi.createMovement).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50, store: 'Costco' })
      );
    });
  });

  it('shows success toast after successful create', async () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50.00' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText(/expense added/i)).toBeInTheDocument();
    });
  });

  it('shows error toast when createMovement fails', async () => {
    vi.mocked(movementsApi.createMovement).mockRejectedValue(new Error('Network error'));
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50.00' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.getByText(/network error/i)).toBeInTheDocument();
    });
  });

  it('calls onSaved after successful create (after 1200ms)', async () => {
    vi.useFakeTimers();
    const { onSaved } = renderForm();
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50.00' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(1200));
    expect(onSaved).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  // --- File upload ---

  it('calls createAttachment for each selected file after create', async () => {
    renderForm();
    const fileInput = screen.getByLabelText(/attachments/i);
    const file = new File(['content'], 'receipt.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25.00' } });
    fireEvent.click(screen.getByRole('button', { name: /add expense/i }));
    await waitFor(() => {
      expect(attachmentsApi.createAttachment).toHaveBeenCalledWith(file, 99);
    });
  });

  // --- AI suggestion ---

  it('calls suggestCategory after 400ms debounce on store change', async () => {
    vi.useFakeTimers();
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('e.g. Walmart'), { target: { value: 'Starbucks' } });
    expect(suggestApi.suggestCategory).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(suggestApi.suggestCategory).toHaveBeenCalledWith(
      expect.objectContaining({ store: 'Starbucks' })
    );
    vi.useRealTimers();
  });

  it('shows AI suggested badge when suggestion returns a match', async () => {
    vi.useFakeTimers();
    vi.mocked(suggestApi.suggestCategory).mockResolvedValue({
      categoryId: 1,
      categoryName: 'Food',
      color: '#FF5733',
    });
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('e.g. Walmart'), { target: { value: 'Subway' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/ai suggested/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('clears AI suggested badge when category is manually changed', async () => {
    vi.useFakeTimers();
    vi.mocked(suggestApi.suggestCategory).mockResolvedValue({
      categoryId: 1,
      categoryName: 'Food',
      color: '#FF5733',
    });
    renderForm();
    fireEvent.change(screen.getByPlaceholderText('e.g. Walmart'), { target: { value: 'Subway' } });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText(/ai suggested/i)).toBeInTheDocument();
    // Manually change category
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '2' } });
    expect(screen.queryByText(/ai suggested/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // --- Edit mode ---

  it('shows "Edit Expense" title in edit mode', async () => {
    renderForm({ movement: mockExistingMovement });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /edit expense/i })).toBeInTheDocument();
    });
  });

  it('pre-populates amount and store from movement prop', async () => {
    renderForm({ movement: mockExistingMovement });
    await waitFor(() => {
      expect(screen.getByDisplayValue('99.99')).toBeInTheDocument();
      expect(screen.getByDisplayValue('TestStore')).toBeInTheDocument();
    });
  });

  it('shows existing attachments in edit mode', async () => {
    renderForm({ movement: mockExistingMovement });
    await waitFor(() => {
      expect(screen.getByText('receipt.jpg')).toBeInTheDocument();
    });
  });

  it('calls updateMovement instead of createMovement in edit mode', async () => {
    renderForm({ movement: mockExistingMovement });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => {
      expect(movementsApi.updateMovement).toHaveBeenCalledWith(42, expect.any(Object));
      expect(movementsApi.createMovement).not.toHaveBeenCalled();
    });
  });

  it('calls deleteAttachment and removes attachment from list when remove is clicked', async () => {
    renderForm({ movement: mockExistingMovement });
    expect(screen.getByText('receipt.jpg')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove receipt\.jpg/i }));
    await waitFor(() => {
      expect(attachmentsApi.deleteAttachment).toHaveBeenCalledWith(10);
    });
    expect(screen.queryByText('receipt.jpg')).not.toBeInTheDocument();
  });
});
