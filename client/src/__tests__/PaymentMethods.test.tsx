import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PaymentMethods } from '../pages/PaymentMethods';
import * as paymentMethodsApi from '../api/paymentMethods';

vi.mock('../api/paymentMethods');

const cash: paymentMethodsApi.PaymentMethod = {
  id: 1,
  name: 'Cash',
  kind: 'cash',
  brand: null,
  variant: null,
  last4: null,
  movement_count: 0,
  created_at: '2026-01-01T00:00:00Z',
};

const visaCard: paymentMethodsApi.PaymentMethod = {
  id: 2,
  name: 'Visa Platinum DAVIbank',
  kind: 'card',
  brand: 'visa',
  variant: 'Platinum',
  last4: '4821',
  movement_count: 5,
  created_at: '2026-01-02T00:00:00Z',
};

const transfer: paymentMethodsApi.PaymentMethod = {
  id: 3,
  name: 'Bancolombia Transfer',
  kind: 'bank_transfer',
  brand: null,
  variant: null,
  last4: null,
  movement_count: 0,
  created_at: '2026-01-03T00:00:00Z',
};

const allMethods = [transfer, cash, visaCard];

function renderPage() {
  return render(
    <MemoryRouter>
      <PaymentMethods />
    </MemoryRouter>
  );
}

describe('PaymentMethods page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows skeleton loader while fetching', () => {
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByTestId('payment-methods-skeleton')).toBeInTheDocument();
  });

  it('renders all methods with name and movement count badge', async () => {
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
    renderPage();
    await waitFor(() => expect(screen.getByText('Cash', { selector: 'span' })).toBeInTheDocument());
    expect(screen.getByText('Visa Platinum DAVIbank')).toBeInTheDocument();
    expect(screen.getByText('Bancolombia Transfer')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders the kind icon per row: 💵 cash, 💳 card, 🏦 transfer', async () => {
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
    renderPage();
    await waitFor(() => expect(screen.getByText('Cash', { selector: 'span' })).toBeInTheDocument());
    expect(screen.getByText('💵')).toBeInTheDocument();
    expect(screen.getByText('💳')).toBeInTheDocument();
    expect(screen.getByText('🏦')).toBeInTheDocument();
  });

  it('shows brand label and variant chips on card rows', async () => {
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
    renderPage();
    await waitFor(() => expect(screen.getByText('Visa Platinum DAVIbank')).toBeInTheDocument());
    expect(screen.getByText('Visa', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Platinum')).toBeInTheDocument();
  });

  it('renders last4 as •••• 4821 when set', async () => {
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
    renderPage();
    await waitFor(() => expect(screen.getByText('•••• 4821')).toBeInTheDocument());
  });

  describe('first-card prompt', () => {
    it('shows the prompt card when only the seeded Cash method exists', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue([cash]);
      renderPage();
      await waitFor(() => {
        expect(
          screen.getByText(/register your first card to track how you pay/i)
        ).toBeInTheDocument();
      });
    });

    it('focuses the add-form name input when the prompt is shown', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue([cash]);
      renderPage();
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/payment method name/i)).toHaveFocus();
      });
    });

    it('does not show the prompt when other methods exist', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => expect(screen.getByText('Cash', { selector: 'span' })).toBeInTheDocument());
      expect(
        screen.queryByText(/register your first card to track how you pay/i)
      ).not.toBeInTheDocument();
    });
  });

  describe('Add payment method form', () => {
    it('renders name input and kind select at the top', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/payment method name/i)).toBeInTheDocument();
      });
      expect(screen.getByRole('combobox', { name: /kind/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add payment method/i })).toBeInTheDocument();
    });

    it('reveals brand, variant, and last4 inputs when kind is card', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByRole('combobox', { name: /kind/i }));
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: /kind/i }), 'card');
      expect(screen.getByRole('combobox', { name: /^brand$/i })).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/variant/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/last 4 digits/i)).toBeInTheDocument();
    });

    it('hides brand, variant, and last4 inputs when kind is cash', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByRole('combobox', { name: /kind/i }));
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: /kind/i }), 'cash');
      expect(screen.queryByRole('combobox', { name: /^brand$/i })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/variant/i)).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/last 4 digits/i)).not.toBeInTheDocument();
    });

    it('creates a card with brand, variant, and last4 on submit', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockResolvedValue({
        id: 4,
        name: 'Master Black',
        kind: 'card',
        brand: 'mastercard',
        variant: 'Black',
        last4: '9999',
        movement_count: 0,
        created_at: '',
      });
      renderPage();
      await waitFor(() => screen.getByPlaceholderText(/payment method name/i));
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: /kind/i }), 'card');
      await user.type(screen.getByPlaceholderText(/payment method name/i), 'Master Black');
      await user.selectOptions(screen.getByRole('combobox', { name: /^brand$/i }), 'mastercard');
      await user.type(screen.getByPlaceholderText(/variant/i), 'Black');
      await user.type(screen.getByPlaceholderText(/last 4 digits/i), '9999');
      await user.click(screen.getByRole('button', { name: /add payment method/i }));
      await waitFor(() => {
        expect(paymentMethodsApi.createPaymentMethod).toHaveBeenCalledWith({
          name: 'Master Black',
          kind: 'card',
          brand: 'mastercard',
          variant: 'Black',
          last4: '9999',
        });
      });
      expect(await screen.findByText('Master Black')).toBeInTheDocument();
    });

    it('creates a non-card method without brand fields', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockResolvedValue({
        id: 5,
        name: 'Nequi',
        kind: 'other',
        brand: null,
        variant: null,
        last4: null,
        movement_count: 0,
        created_at: '',
      });
      renderPage();
      await waitFor(() => screen.getByPlaceholderText(/payment method name/i));
      const user = userEvent.setup();
      await user.selectOptions(screen.getByRole('combobox', { name: /kind/i }), 'other');
      await user.type(screen.getByPlaceholderText(/payment method name/i), 'Nequi');
      await user.click(screen.getByRole('button', { name: /add payment method/i }));
      await waitFor(() => {
        expect(paymentMethodsApi.createPaymentMethod).toHaveBeenCalledWith({
          name: 'Nequi',
          kind: 'other',
        });
      });
    });

    it('does not submit when name is empty', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByRole('button', { name: /add payment method/i }));
      fireEvent.click(screen.getByRole('button', { name: /add payment method/i }));
      expect(paymentMethodsApi.createPaymentMethod).not.toHaveBeenCalled();
    });

    it('clears the form after a successful submit', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockResolvedValue({
        id: 6,
        name: 'Test',
        kind: 'card',
        brand: null,
        variant: null,
        last4: null,
        movement_count: 0,
        created_at: '',
      });
      renderPage();
      await waitFor(() => screen.getByPlaceholderText(/payment method name/i));
      const user = userEvent.setup();
      const nameInput = screen.getByPlaceholderText(/payment method name/i);
      await user.type(nameInput, 'Test');
      await user.click(screen.getByRole('button', { name: /add payment method/i }));
      await waitFor(() => expect(nameInput).toHaveValue(''));
    });
  });

  describe('Inline editing', () => {
    it('shows an edit button on each row, including the seeded Cash row', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Cash', { selector: 'span' }));
      const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
      expect(editButtons).toHaveLength(3);
      editButtons.forEach((btn) => expect(btn).not.toBeDisabled());
    });

    it('clicking edit shows an input pre-filled with the name', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Visa Platinum DAVIbank'));
      const user = userEvent.setup();
      // rows are ordered by name: Bancolombia Transfer, Cash, Visa Platinum DAVIbank
      const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
      await user.click(editButtons[2]);
      expect(screen.getByDisplayValue('Visa Platinum DAVIbank')).toBeInTheDocument();
    });

    it('shows brand, variant, and last4 editors when editing a card row', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Visa Platinum DAVIbank'));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
      await user.click(editButtons[2]);
      expect(screen.getByRole('combobox', { name: /edit brand/i })).toHaveValue('visa');
      expect(screen.getByDisplayValue('Platinum')).toBeInTheDocument();
      expect(screen.getByDisplayValue('4821')).toBeInTheDocument();
    });

    it('saves the edited name on Enter', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.updatePaymentMethod).mockResolvedValue({
        ...cash,
        name: 'Efectivo',
      });
      renderPage();
      await waitFor(() => screen.getByText('Cash', { selector: 'span' }));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
      await user.click(editButtons[1]);
      const input = screen.getByDisplayValue('Cash');
      await user.clear(input);
      await user.type(input, 'Efectivo');
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(paymentMethodsApi.updatePaymentMethod).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ name: 'Efectivo' })
        );
      });
      expect(await screen.findByText('Efectivo')).toBeInTheDocument();
    });

    it('saves on blur', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.updatePaymentMethod).mockResolvedValue({
        ...visaCard,
        variant: 'Signature',
      });
      renderPage();
      await waitFor(() => screen.getByText('Visa Platinum DAVIbank'));
      const user = userEvent.setup();
      const editButtons = screen.getAllByRole('button', { name: /^edit$/i });
      await user.click(editButtons[2]);
      const variantInput = screen.getByDisplayValue('Platinum');
      await user.clear(variantInput);
      await user.type(variantInput, 'Signature');
      fireEvent.blur(variantInput);
      await waitFor(() => {
        expect(paymentMethodsApi.updatePaymentMethod).toHaveBeenCalledWith(
          2,
          expect.objectContaining({ variant: 'Signature' })
        );
      });
    });
  });

  describe('Delete', () => {
    it('disables delete with a tooltip showing the movement count when movements are linked', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Visa Platinum DAVIbank'));
      const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
      // rows sorted by name: [Bancolombia Transfer, Cash, Visa Platinum DAVIbank]
      expect(deleteButtons[2]).toBeDisabled();
      expect(deleteButtons[2]).toHaveAttribute('title', expect.stringContaining('5'));
    });

    it('enables delete on rows without movements, including the seeded Cash row', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Cash', { selector: 'span' }));
      const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
      expect(deleteButtons[0]).not.toBeDisabled();
      expect(deleteButtons[1]).not.toBeDisabled();
    });

    it('shows a confirmation popover and deletes on confirm', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      vi.mocked(paymentMethodsApi.deletePaymentMethod).mockResolvedValue(undefined);
      renderPage();
      await waitFor(() => screen.getByText('Cash', { selector: 'span' }));
      const user = userEvent.setup();
      const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
      await user.click(deleteButtons[1]);
      expect(screen.getByText(/confirm delete/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /confirm/i }));
      await waitFor(() => {
        expect(paymentMethodsApi.deletePaymentMethod).toHaveBeenCalledWith(1);
      });
      await waitFor(() => {
        expect(screen.queryByText('Cash', { selector: 'span' })).not.toBeInTheDocument();
      });
    });

    it('cancels deletion when cancel is clicked', async () => {
      vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(allMethods);
      renderPage();
      await waitFor(() => screen.getByText('Cash', { selector: 'span' }));
      const user = userEvent.setup();
      const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
      await user.click(deleteButtons[1]);
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(paymentMethodsApi.deletePaymentMethod).not.toHaveBeenCalled();
      expect(screen.queryByText(/confirm delete/i)).not.toBeInTheDocument();
    });
  });
});
