import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Import } from '../pages/Import';
import * as importApi from '../api/import';
import * as categoriesApi from '../api/categories';

vi.mock('../api/import');
vi.mock('../api/categories');
vi.mock('../api/suggest');

const mockCategories: categoriesApi.Category[] = [
  { id: 1, name: 'Food', color: '#ef4444', icon: null, movement_count: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Transport', color: '#3b82f6', icon: null, movement_count: 3, created_at: '2026-01-01T00:00:00Z' },
];

const mockExtractResponse: importApi.ExtractResponse = {
  attachmentId: 42,
  rawText: 'ACME Store\nDate: 2026-06-09\nTotal: $15.99',
  movements: [
    {
      amount: 15.99,
      date: '2026-06-09',
      description: 'Groceries',
      store: 'ACME Store',
      categoryId: 1,
      categoryName: 'Food',
      color: '#ef4444',
      aiSuggested: true,
    },
  ],
};

const mockConfirmResponse: importApi.ConfirmResponse = {
  created: [{ id: 101, amount: '15.99', date: '2026-06-09', description: 'Groceries' }],
  count: 1,
};

const mockFile = new File(['mock content'], 'receipt.jpg', { type: 'image/jpeg' });

function renderImport() {
  return render(
    <MemoryRouter>
      <Import />
    </MemoryRouter>
  );
}

describe('Import page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(categoriesApi.getCategories).mockResolvedValue(mockCategories);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  });

  describe('Upload step', () => {
    it('renders the dropzone by default', () => {
      renderImport();
      expect(screen.getByTestId('dropzone')).toBeInTheDocument();
      expect(screen.getByText(/drag and drop/i)).toBeInTheDocument();
    });

    it('Process Image button is disabled when no file is selected', () => {
      renderImport();
      expect(screen.getByTestId('process-button')).toBeDisabled();
    });

    it('enables Process Image button after file selection', async () => {
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      expect(screen.getByTestId('process-button')).not.toBeDisabled();
    });

    it('shows image preview after image file selection', async () => {
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      expect(screen.getByTestId('file-preview')).toBeInTheDocument();
      expect(screen.getByText('receipt.jpg')).toBeInTheDocument();
    });

    it('shows PDF icon for PDF files', async () => {
      renderImport();
      const pdfFile = new File(['pdf content'], 'invoice.pdf', { type: 'application/pdf' });
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, pdfFile);
      expect(screen.getByTestId('pdf-icon')).toBeInTheDocument();
      expect(screen.getByText('invoice.pdf')).toBeInTheDocument();
    });
  });

  describe('Processing step', () => {
    it('shows processing indicator after clicking Process Image', async () => {
      vi.mocked(importApi.extractFromImage).mockReturnValue(new Promise(() => {}));
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('processing-indicator')).toBeInTheDocument();
      });
      expect(screen.getByText(/extracting text/i)).toBeInTheDocument();
    });
  });

  describe('Review step', () => {
    async function goToReview() {
      vi.mocked(importApi.extractFromImage).mockResolvedValue(mockExtractResponse);
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
    }

    it('shows review table with extracted movements', async () => {
      await goToReview();
      expect(screen.getByDisplayValue('15.99')).toBeInTheDocument();
      expect(screen.getByDisplayValue('2026-06-09')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Groceries')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ACME Store')).toBeInTheDocument();
    });

    it('shows AI suggested badge for AI-suggested categories', async () => {
      await goToReview();
      expect(screen.getByTestId('ai-badge')).toBeInTheDocument();
    });

    it('shows Import button with movement count', async () => {
      await goToReview();
      expect(screen.getByTestId('import-button')).toHaveTextContent('Import 1 Movement');
    });

    it('can add a blank row', async () => {
      await goToReview();
      const rowsBefore = screen.getAllByRole('row').length;
      fireEvent.click(screen.getByTestId('add-row-button'));
      await waitFor(() => {
        expect(screen.getAllByRole('row').length).toBe(rowsBefore + 1);
      });
    });

    it('can remove a row', async () => {
      await goToReview();
      const rowsBefore = screen.getAllByRole('row').length;
      fireEvent.click(screen.getByTestId('remove-row-button'));
      await waitFor(() => {
        expect(screen.getAllByRole('row').length).toBe(rowsBefore - 1);
      });
    });

    it('shows raw extracted text in collapsible panel', async () => {
      await goToReview();
      expect(screen.getByText(/raw extracted text/i)).toBeInTheDocument();
    });

    it('clears AI badge when category is changed manually', async () => {
      await goToReview();
      expect(screen.getByTestId('ai-badge')).toBeInTheDocument();
      const categorySelect = screen.getByRole('combobox', { name: /category/i });
      await userEvent.selectOptions(categorySelect, '2');
      expect(screen.queryByTestId('ai-badge')).not.toBeInTheDocument();
    });

    it('updates amount when edited', async () => {
      await goToReview();
      const amountInput = screen.getByRole('spinbutton', { name: /amount/i });
      await userEvent.clear(amountInput);
      await userEvent.type(amountInput, '25');
      expect(amountInput).toHaveValue(25);
    });
  });

  describe('Confirm step', () => {
    async function goToConfirm() {
      vi.mocked(importApi.extractFromImage).mockResolvedValue(mockExtractResponse);
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
    }

    it('shows success summary with created movements', async () => {
      await goToConfirm();
      expect(screen.getByText(/successfully imported 1 movement/i)).toBeInTheDocument();
    });

    it('calls confirmImport with correct data including attachmentId', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue(mockExtractResponse);
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalledWith({
          attachmentId: 42,
          movements: expect.arrayContaining([
            expect.objectContaining({ amount: 15.99, date: '2026-06-09' }),
          ]),
        });
      });
    });

    it('shows a link to the dashboard after successful import', async () => {
      await goToConfirm();
      expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    });
  });

  describe('Error handling', () => {
    it('shows error notice when AI extraction fails', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        attachmentId: 42,
        rawText: 'Some raw text',
        movements: [],
        error: 'AI extraction failed',
      });
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('extract-error')).toBeInTheDocument();
      });
      expect(screen.getByText(/AI extraction failed/i)).toBeInTheDocument();
    });

    it('shows error notice when extraction request throws', async () => {
      vi.mocked(importApi.extractFromImage).mockRejectedValue(new Error('Network error'));
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('extract-error')).toBeInTheDocument();
      });
    });

    it('lets user add rows manually after extraction error', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        attachmentId: 42,
        rawText: '',
        movements: [],
        error: 'AI extraction failed',
      });
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('add-row-button'));
      await waitFor(() => {
        expect(screen.getAllByRole('row').length).toBeGreaterThan(1); // header + new row
      });
    });
  });
});
