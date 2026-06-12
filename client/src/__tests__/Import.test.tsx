import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Import } from '../pages/Import';
import * as importApi from '../api/import';
import * as categoriesApi from '../api/categories';
import * as paymentMethodsApi from '../api/paymentMethods';
import * as suggestApi from '../api/suggest';
import * as gmailApi from '../api/gmail';

vi.mock('../api/import');
vi.mock('../api/categories');
vi.mock('../api/suggest');
vi.mock('../api/paymentMethods');
vi.mock('../api/gmail');

const mockCategories: categoriesApi.Category[] = [
  { id: 1, name: 'Food', color: '#ef4444', icon: null, movement_count: 5, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, name: 'Transport', color: '#3b82f6', icon: null, movement_count: 3, created_at: '2026-01-01T00:00:00Z' },
];

const mockPaymentMethods: paymentMethodsApi.PaymentMethod[] = [
  {
    id: 1,
    name: 'Cash',
    kind: 'cash',
    brand: null,
    variant: null,
    last4: null,
    movement_count: 2,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 2,
    name: 'Visa Gold DAVIbank',
    kind: 'card',
    brand: 'visa',
    variant: 'gold',
    last4: '4321',
    movement_count: 7,
    created_at: '2026-01-01T00:00:00Z',
  },
];

const noPayment = {
  paymentMethodId: null,
  paymentMethodName: null,
  detectedPaymentLabel: null,
  detectedBrand: null,
  detectedVariant: null,
  paymentAiSuggested: false,
};

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
      suggestedNewCategory: null,
      ...noPayment,
    },
  ],
};

const mockConfirmResponse: importApi.ConfirmResponse = {
  created: [
    {
      id: 101,
      amount: '15.99',
      date: '2026-06-09',
      description: 'Groceries',
      store: 'ACME Store',
      category_id: 1,
      payment_method_id: null,
    },
  ],
  count: 1,
  resolvedCategories: [],
};

const mockFile = new File(['mock content'], 'receipt.jpg', { type: 'image/jpeg' });

const mockSenders: gmailApi.GmailSender[] = [
  {
    id: 1,
    email: 'alerts@davibank.com',
    label: 'DAVIbank alerts',
    subject_contains: 'Alerta de compra',
    created_at: '2026-06-01T00:00:00Z',
  },
];

const mockMessages: gmailApi.GmailMessage[] = [
  {
    id: 'gmail-1',
    threadId: 'thread-1',
    from: 'alerts@davibank.com',
    subject: 'Alerta de compra',
    date: '2026-06-10T15:30:00Z',
    snippet: 'Compra por $15.99 en ACME Store',
    alreadyImported: false,
  },
  {
    id: 'gmail-2',
    threadId: 'thread-2',
    from: 'alerts@davibank.com',
    subject: 'Alerta de compra',
    date: '2026-06-09T12:00:00Z',
    snippet: 'Compra por $25.00 en Coffee Bar',
    alreadyImported: true,
  },
];

const mockPendingEmail: gmailApi.GmailPendingEmail = {
  messageId: 'pending-1',
  from: 'alerts@davibank.com',
  subject: 'Alerta de compra pendiente',
  date: '2026-06-11T14:30:00Z',
  status: 'pending',
  error: null,
  detectedAt: '2026-06-11T14:35:00Z',
  extractedAt: '2026-06-11T14:36:00Z',
  movements: [
    {
      ...mockExtractResponse.movements[0],
      amount: 42.5,
      date: '2026-06-11',
      store: 'Pending Store',
      description: 'Pending purchase',
      gmailMessageId: 'pending-1',
      source: 'gmail',
    },
  ],
};

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
    vi.mocked(paymentMethodsApi.getPaymentMethods).mockResolvedValue(mockPaymentMethods);
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue({
      connected: true,
      email: 'me@example.com',
      connectedAt: '2026-06-01T00:00:00Z',
    });
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValue(mockSenders);
    vi.mocked(gmailApi.getGmailMessages).mockResolvedValue({
      messages: mockMessages,
      nextPageToken: null,
    });
    vi.mocked(gmailApi.getGmailPending).mockImplementation(async (status = 'pending') => ({
      emails: status === 'pending' ? [mockPendingEmail] : [],
    }));
    vi.mocked(gmailApi.dismissGmailPending).mockResolvedValue();
    vi.mocked(gmailApi.retryGmailPending).mockResolvedValue({ newEmails: 1, errors: 0 });
    vi.mocked(gmailApi.pollGmailNow).mockResolvedValue({ newEmails: 1, errors: 0 });
    vi.mocked(gmailApi.requestGmailPendingRefresh).mockImplementation(() => {});
    vi.mocked(importApi.extractFromEmails).mockResolvedValue({
      emails: [
        {
          messageId: 'gmail-1',
          subject: 'Alerta de compra',
          from: 'alerts@davibank.com',
          date: '2026-06-10T15:30:00Z',
          movements: [mockExtractResponse.movements[0]],
          error: null,
        },
      ],
      language: 'es',
    });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  });

  describe('Gmail picker', () => {
    it('renders source tabs and keeps the upload flow as the default', () => {
      renderImport();
      expect(screen.getByRole('tab', { name: /upload receipt/i })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /from gmail/i })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByTestId('dropzone')).toBeInTheDocument();
    });

    it('guards the Gmail tab when Gmail is not connected', async () => {
      vi.mocked(gmailApi.getGmailStatus).mockResolvedValue({ connected: false, email: null, connectedAt: null });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByRole('heading', { name: /connect gmail/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /connect gmail/i })).toHaveAttribute('href', '/settings/gmail');
      expect(gmailApi.getGmailMessages).not.toHaveBeenCalled();
    });

    it('guards the Gmail tab when no sender filters are configured', async () => {
      vi.mocked(gmailApi.getGmailSenders).mockResolvedValue([]);
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByText(/add the addresses your bank sends purchase alerts from/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /configure senders/i })).toHaveAttribute('href', '/settings/gmail');
    });

    it('lists Gmail messages with imported rows disabled', async () => {
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findAllByText('Alerta de compra')).toHaveLength(2);
      expect(screen.getByText(/compra por \$15.99/i)).toBeInTheDocument();
      expect(screen.getByText('Imported')).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: /select email gmail-2/i })).toBeDisabled();
    });

    it('passes filters and appends the next page when loading more', async () => {
      vi.mocked(gmailApi.getGmailMessages)
        .mockResolvedValueOnce({ messages: [mockMessages[0]], nextPageToken: 'page-2' })
        .mockResolvedValueOnce({
          messages: [{ ...mockMessages[1], alreadyImported: false }],
          nextPageToken: null,
        })
        .mockResolvedValueOnce({
          messages: [{ ...mockMessages[1], alreadyImported: false }],
          nextPageToken: null,
        })
        .mockResolvedValue({ messages: [mockMessages[0]], nextPageToken: null });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await screen.findByText(/compra por \$15.99/i);
      await userEvent.click(screen.getByRole('button', { name: /load more/i }));
      await waitFor(() => {
        expect(gmailApi.getGmailMessages).toHaveBeenLastCalledWith(
          expect.objectContaining({ pageToken: 'page-2' })
        );
      });
      expect(await screen.findByText(/coffee bar/i)).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByRole('combobox', { name: /sender/i }), 'alerts@davibank.com');
      await userEvent.type(screen.getByRole('searchbox', { name: /subject/i }), 'compra');
      await waitFor(() => {
        expect(gmailApi.getGmailMessages).toHaveBeenLastCalledWith(
          expect.objectContaining({ sender: 'alerts@davibank.com', subject: 'compra' })
        );
      });
    });

    it('caps selection at 25 messages', async () => {
      const manyMessages = Array.from({ length: 26 }, (_, index) => ({
        ...mockMessages[0],
        id: `gmail-${index + 1}`,
        threadId: `thread-${index + 1}`,
        snippet: `Message ${index + 1}`,
      }));
      vi.mocked(gmailApi.getGmailMessages).mockResolvedValue({ messages: manyMessages, nextPageToken: null });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      const boxes = await screen.findAllByRole('checkbox', { name: /select email/i });
      for (const box of boxes.slice(0, 25)) {
        await userEvent.click(box);
      }
      expect(screen.getByText('25 / 25 selected')).toBeInTheDocument();
      expect(boxes[25]).toBeDisabled();
    });

    it('extracts selected emails and feeds movements into the existing review table', async () => {
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 1 email/i }));
      await waitFor(() => {
        expect(importApi.extractFromEmails).toHaveBeenCalledWith(['gmail-1']);
      });
      expect(await screen.findByTestId('movements-table')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ACME Store')).toBeInTheDocument();
    });

    it('shows pending cards and reviews stored movements without re-extraction', async () => {
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByText('Alerta de compra pendiente')).toBeInTheDocument();
      expect(screen.getByText(/pending store — \$42.50 — 2026-06-11/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('checkbox', { name: /select pending email pending-1/i }));
      await userEvent.click(screen.getByRole('button', { name: /review 1 email/i }));
      expect(await screen.findByTestId('movements-table')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Pending Store')).toBeInTheDocument();
      expect(importApi.extractFromEmails).not.toHaveBeenCalled();
    });

    it('dismisses a pending card and refreshes the notification badge', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByText('Alerta de compra pendiente')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /dismiss pending-1/i }));
      await waitFor(() => {
        expect(gmailApi.dismissGmailPending).toHaveBeenCalledWith('pending-1');
      });
      expect(gmailApi.requestGmailPendingRefresh).toHaveBeenCalled();
      expect(screen.queryByText('Alerta de compra pendiente')).not.toBeInTheDocument();
    });

    it('renders error pending cards and retries them', async () => {
      vi.mocked(gmailApi.getGmailPending).mockImplementation(async (status = 'pending') => ({
        emails:
          status === 'error'
            ? [
                {
                  ...mockPendingEmail,
                  messageId: 'error-1',
                  status: 'error',
                  subject: 'Broken alert',
                  movements: [],
                  error: 'Model failed',
                },
              ]
            : [],
      }));
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByText('Broken alert')).toBeInTheDocument();
      expect(screen.getByText('Model failed')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));
      await waitFor(() => {
        expect(gmailApi.retryGmailPending).toHaveBeenCalledWith('error-1');
      });
    });

    it('checks Gmail now and updates the last checked readout', async () => {
      vi.mocked(gmailApi.getGmailStatus)
        .mockResolvedValueOnce({
          connected: true,
          email: 'me@example.com',
          connectedAt: '2026-06-01T00:00:00Z',
          lastPolledAt: null,
        })
        .mockResolvedValueOnce({
          connected: true,
          email: 'me@example.com',
          connectedAt: '2026-06-01T00:00:00Z',
          lastPolledAt: '2026-06-12T10:00:00Z',
        });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      expect(await screen.findByText(/last checked: never/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /check now/i }));
      await waitFor(() => {
        expect(gmailApi.pollGmailNow).toHaveBeenCalled();
      });
      expect(await screen.findByText(/last checked:/i)).toHaveTextContent('2026');
    });

    it('renders per-email extraction errors and retries a single message', async () => {
      vi.mocked(importApi.extractFromEmails)
        .mockResolvedValueOnce({
          emails: [
            {
              messageId: 'gmail-1',
              subject: 'Alerta de compra',
              from: 'alerts@davibank.com',
              date: '2026-06-10T15:30:00Z',
              movements: [],
              error: 'Model failed',
            },
          ],
          language: 'es',
        })
        .mockResolvedValueOnce({
          emails: [
            {
              messageId: 'gmail-1',
              subject: 'Alerta de compra',
              from: 'alerts@davibank.com',
              date: '2026-06-10T15:30:00Z',
              movements: [mockExtractResponse.movements[0]],
              error: null,
            },
          ],
          language: 'es',
        });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 1 email/i }));
      expect(await screen.findByText(/model failed/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /retry/i }));
      await waitFor(() => {
        expect(importApi.extractFromEmails).toHaveBeenLastCalledWith(['gmail-1']);
      });
      expect(await screen.findByTestId('movements-table')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ACME Store')).toBeInTheDocument();
    });

    it('shows mixed extraction errors above review rows and retries without disturbing extracted rows', async () => {
      vi.mocked(importApi.extractFromEmails)
        .mockResolvedValueOnce({
          emails: [
            {
              messageId: 'gmail-1',
              subject: 'Alerta de compra',
              from: 'alerts@davibank.com',
              date: '2026-06-10T15:30:00Z',
              movements: [mockExtractResponse.movements[0]],
              error: null,
            },
            {
              messageId: 'gmail-3',
              subject: 'Alerta de compra',
              from: 'alerts@davibank.com',
              date: '2026-06-10T16:00:00Z',
              movements: [],
              error: 'Fetch failed',
            },
          ],
          language: 'es',
        })
        .mockResolvedValueOnce({
          emails: [
            {
              messageId: 'gmail-3',
              subject: 'Alerta de compra',
              from: 'alerts@davibank.com',
              date: '2026-06-10T16:00:00Z',
              movements: [{ ...mockExtractResponse.movements[0], store: 'Coffee Bar' }],
              error: null,
            },
          ],
          language: 'es',
        });
      vi.mocked(gmailApi.getGmailMessages).mockResolvedValue({
        messages: [
          mockMessages[0],
          {
            ...mockMessages[0],
            id: 'gmail-3',
            threadId: 'thread-3',
            snippet: 'Compra por $8.00 en Coffee Bar',
          },
        ],
        nextPageToken: null,
      });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('checkbox', { name: /select email gmail-3/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 2 emails/i }));
      expect(await screen.findByText(/fetch failed/i)).toBeInTheDocument();
      expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ACME Store')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(await screen.findByTestId('movements-table')).toBeInTheDocument();
      expect(screen.getByDisplayValue('ACME Store')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Coffee Bar')).toBeInTheDocument();
    });
  });

  describe('Gmail review and confirm', () => {
    async function goToGmailReview() {
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 1 email/i }));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
    }

    it('shows a Source column with the email subject and a from/date tooltip for gmail rows', async () => {
      await goToGmailReview();
      expect(screen.getByText('Source')).toBeInTheDocument();
      const cell = screen.getByTestId('source-cell');
      expect(cell).toHaveTextContent('Alerta de compra');
      expect(cell.title).toContain('alerts@davibank.com');
    });

    it('hides the Source column entirely for upload imports', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue(mockExtractResponse);
      renderImport();
      await userEvent.upload(screen.getByTestId('file-input'), mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      expect(screen.queryByText('Source')).not.toBeInTheDocument();
      expect(screen.queryByTestId('source-cell')).not.toBeInTheDocument();
    });

    it('includes each row gmail_message_id in the confirm payload', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToGmailReview();
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalledWith({
          attachmentId: undefined,
          movements: [expect.objectContaining({ gmail_message_id: 'gmail-1' })],
        });
      });
    });

    it('marks conflicting rows on 409 and confirms the remaining rows without re-extracting', async () => {
      vi.mocked(gmailApi.getGmailMessages).mockResolvedValue({
        messages: [
          mockMessages[0],
          { ...mockMessages[0], id: 'gmail-3', threadId: 'thread-3', snippet: 'Compra por $8.00 en Coffee Bar' },
        ],
        nextPageToken: null,
      });
      vi.mocked(importApi.extractFromEmails).mockResolvedValue({
        emails: [
          {
            messageId: 'gmail-1',
            subject: 'Alerta de compra',
            from: 'alerts@davibank.com',
            date: '2026-06-10T15:30:00Z',
            movements: [mockExtractResponse.movements[0]],
            error: null,
          },
          {
            messageId: 'gmail-3',
            subject: 'Alerta de compra',
            from: 'alerts@davibank.com',
            date: '2026-06-10T16:00:00Z',
            movements: [{ ...mockExtractResponse.movements[0], store: 'Coffee Bar' }],
            error: null,
          },
        ],
        language: 'es',
      });
      vi.mocked(importApi.confirmImport)
        .mockRejectedValueOnce({
          isAxiosError: true,
          response: {
            status: 409,
            data: {
              error: 'Some emails were already imported',
              details: { alreadyImported: ['gmail-1'] },
            },
          },
        })
        .mockResolvedValueOnce(mockConfirmResponse);
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('checkbox', { name: /select email gmail-3/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 2 emails/i }));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('import-button'));
      expect(await screen.findByTestId('already-imported-badge')).toHaveTextContent(/already imported/i);
      expect(screen.getByTestId('import-button')).toHaveTextContent('Import 1 Movement');
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenLastCalledWith({
          attachmentId: undefined,
          movements: [
            expect.objectContaining({ gmail_message_id: 'gmail-3', store: 'Coffee Bar' }),
          ],
        });
      });
      expect(await screen.findByTestId('success-summary')).toBeInTheDocument();
    });

    it('shows a friendly empty state with a back-to-list action when no movements are found', async () => {
      vi.mocked(importApi.extractFromEmails).mockResolvedValue({
        emails: [
          {
            messageId: 'gmail-1',
            subject: 'Alerta de compra',
            from: 'alerts@davibank.com',
            date: '2026-06-10T15:30:00Z',
            movements: [],
            error: null,
          },
        ],
        language: 'es',
      });
      renderImport();
      await userEvent.click(screen.getByRole('tab', { name: /from gmail/i }));
      await userEvent.click(await screen.findByRole('checkbox', { name: /select email gmail-1/i }));
      await userEvent.click(screen.getByRole('button', { name: /extract 1 email/i }));
      expect(await screen.findByText(/no movements found in the selected emails/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /back to email list/i }));
      expect(await screen.findByRole('checkbox', { name: /select email gmail-1/i })).toBeInTheDocument();
    });

    it('reports imported emails in the success summary and refreshes badges without a reload', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToGmailReview();
      const listCalls = vi.mocked(gmailApi.getGmailMessages).mock.calls.length;
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      expect(screen.getByTestId('imported-emails-summary')).toHaveTextContent(
        '1 email marked as imported'
      );
      expect(gmailApi.requestGmailPendingRefresh).toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: /back to gmail emails/i }));
      const checkbox = await screen.findByRole('checkbox', { name: /select email gmail-1/i });
      expect(checkbox).toBeDisabled();
      expect(screen.getAllByText('Imported')).toHaveLength(2);
      expect(vi.mocked(gmailApi.getGmailMessages).mock.calls.length).toBe(listCalls);
    });

    it('omits the imported-emails line for upload-sourced confirms', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue(mockExtractResponse);
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      renderImport();
      await userEvent.upload(screen.getByTestId('file-input'), mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('imported-emails-summary')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /back to gmail emails/i })).not.toBeInTheDocument();
    });
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

    it('shows and submits extracted movement time from the review table', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        ...mockExtractResponse,
        movements: [{ ...mockExtractResponse.movements[0], time: '14:32' }],
      });
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      renderImport();
      await userEvent.upload(screen.getByTestId('file-input'), mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
      const timeInput = screen.getByLabelText(/time/i);
      expect(timeInput).toHaveValue('14:32');
      await userEvent.clear(timeInput);
      await userEvent.type(timeInput, '15:45');
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalledWith({
          attachmentId: 42,
          movements: [expect.objectContaining({ time: '15:45' })],
        });
      });
    });

    it('shows a possible duplicate badge without blocking import', async () => {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        ...mockExtractResponse,
        movements: [
          {
            ...mockExtractResponse.movements[0],
            possibleDuplicate: true,
            duplicateOf: {
              id: 42,
              date: '2026-06-09',
              time: '14:32',
              description: 'Groceries',
            },
          },
        ],
      });
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      renderImport();
      await userEvent.upload(screen.getByTestId('file-input'), mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      const badge = await screen.findByTestId('possible-duplicate-badge');
      expect(badge).toHaveTextContent(/possible duplicate/i);
      expect(badge.title).toContain('movement #42');
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalled();
      });
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

  describe('Payment method column', () => {
    async function goToReviewWith(movements: importApi.ExtractResponse['movements']) {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        ...mockExtractResponse,
        movements,
      });
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
    }

    it('renders a Paid with column with a select populated from payment methods', async () => {
      await goToReviewWith(mockExtractResponse.movements);
      expect(screen.getByText('Paid with')).toBeInTheDocument();
      const select = screen.getByRole('combobox', { name: /paid with/i });
      expect(select).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole('option', { name: /visa gold davibank/i })).toBeInTheDocument();
      });
      expect(screen.getByRole('option', { name: /cash/i })).toBeInTheDocument();
    });

    it('pre-selects the AI-matched method and shows the AI detected badge', async () => {
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          paymentMethodId: 2,
          paymentMethodName: 'Visa Gold DAVIbank',
          paymentAiSuggested: true,
        },
      ]);
      const select = screen.getByRole('combobox', { name: /paid with/i });
      await waitFor(() => {
        expect(select).toHaveValue('2');
      });
      expect(screen.getByTestId('payment-ai-badge')).toBeInTheDocument();
    });

    it('clears the AI detected badge when the select is changed manually', async () => {
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          paymentMethodId: 2,
          paymentMethodName: 'Visa Gold DAVIbank',
          paymentAiSuggested: true,
        },
      ]);
      await waitFor(() => {
        expect(screen.getByTestId('payment-ai-badge')).toBeInTheDocument();
      });
      const select = screen.getByRole('combobox', { name: /paid with/i });
      await userEvent.selectOptions(select, '1');
      expect(screen.queryByTestId('payment-ai-badge')).not.toBeInTheDocument();
    });

    it('shows a register prompt when an unregistered card was detected', async () => {
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ]);
      expect(screen.getByText(/detected "visa platinum"/i)).toBeInTheDocument();
      expect(screen.getByTestId('register-card-button')).toBeInTheDocument();
    });

    it('registers the detected card and selects it in the row', async () => {
      const newMethod: paymentMethodsApi.PaymentMethod = {
        id: 3,
        name: 'Visa Platinum',
        kind: 'card',
        brand: 'visa',
        variant: 'platinum',
        last4: null,
        movement_count: 0,
        created_at: '2026-06-10T00:00:00Z',
      };
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockResolvedValue(newMethod);
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ]);
      fireEvent.click(screen.getByTestId('register-card-button'));
      await waitFor(() => {
        expect(paymentMethodsApi.createPaymentMethod).toHaveBeenCalledWith({
          name: 'Visa Platinum',
          kind: 'card',
          brand: 'visa',
          variant: 'platinum',
        });
      });
      const select = screen.getByRole('combobox', { name: /paid with/i });
      await waitFor(() => {
        expect(select).toHaveValue('3');
      });
      expect(screen.getByRole('option', { name: /visa platinum/i })).toBeInTheDocument();
      expect(screen.queryByTestId('register-card-button')).not.toBeInTheDocument();
    });

    it('shows the server error and keeps the register prompt when registration fails', async () => {
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockRejectedValue({
        isAxiosError: true,
        response: { data: { error: "Payment method name 'Visa Platinum' already exists" } },
      });
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ]);
      fireEvent.click(screen.getByTestId('register-card-button'));
      await waitFor(() => {
        expect(screen.getByTestId('register-card-error')).toHaveTextContent(
          "Payment method name 'Visa Platinum' already exists"
        );
      });
      expect(screen.getByTestId('register-card-button')).not.toBeDisabled();
    });

    it('shows a generic error when registration fails without a server message', async () => {
      vi.mocked(paymentMethodsApi.createPaymentMethod).mockRejectedValue(new Error('network'));
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          detectedPaymentLabel: 'Visa Platinum',
          detectedBrand: 'visa',
          detectedVariant: 'platinum',
        },
      ]);
      fireEvent.click(screen.getByTestId('register-card-button'));
      await waitFor(() => {
        expect(screen.getByTestId('register-card-error')).toHaveTextContent(/could not register/i);
      });
    });

    it('includes payment_method_id in the confirm payload', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          paymentMethodId: 2,
          paymentMethodName: 'Visa Gold DAVIbank',
          paymentAiSuggested: true,
        },
      ]);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalledWith({
          attachmentId: 42,
          movements: [expect.objectContaining({ payment_method_id: 2 })],
        });
      });
    });

    it('shows the payment method with icon, date, store, and amount in the success summary', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue({
        created: [
          {
            id: 101,
            amount: '15.99',
            date: '2026-06-09',
            description: 'Groceries',
            store: 'ACME Store',
            category_id: 1,
            payment_method_id: 2,
          },
        ],
        count: 1,
        resolvedCategories: [],
      });
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          paymentMethodId: 2,
          paymentMethodName: 'Visa Gold DAVIbank',
          paymentAiSuggested: true,
        },
      ]);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      const badge = screen.getByTestId('summary-payment-method');
      expect(badge).toHaveTextContent('💳');
      expect(badge).toHaveTextContent('Visa Gold DAVIbank');
      expect(screen.getByText('2026-06-09')).toBeInTheDocument();
      expect(screen.getByText('ACME Store')).toBeInTheDocument();
      expect(screen.getByText('$15.99')).toBeInTheDocument();
    });

    it('omits the payment badge in the summary when the movement has none', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith(mockExtractResponse.movements);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('summary-payment-method')).not.toBeInTheDocument();
    });
  });

  describe('AI-suggested new category', () => {
    const suggestionMovement: importApi.ExtractedMovement = {
      amount: 25,
      date: '2026-06-09',
      description: 'AI credits',
      store: 'OPENROUTER, INC',
      categoryId: null,
      categoryName: null,
      color: null,
      aiSuggested: false,
      suggestedNewCategory: 'Software',
      ...noPayment,
    };

    async function goToReviewWith(movements: importApi.ExtractResponse['movements']) {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        ...mockExtractResponse,
        movements,
      });
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
    }

    it('renders an editable text input pre-filled with the suggestion and an AI suggested badge', async () => {
      await goToReviewWith([suggestionMovement]);
      const input = screen.getByTestId('new-category-input');
      expect(input).toHaveValue('Software');
      expect(screen.getByTestId('new-category-ai-badge')).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Category' })).not.toBeInTheDocument();
    });

    it('keeps the plain select when there is no suggestion', async () => {
      await goToReviewWith(mockExtractResponse.movements);
      expect(screen.queryByTestId('new-category-input')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    });

    it('lets the user type a new category when no suggestion fits and sends it on confirm', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith([
        {
          ...mockExtractResponse.movements[0],
          categoryId: null,
          categoryName: null,
          color: null,
          aiSuggested: false,
          suggestedNewCategory: null,
        },
      ]);

      fireEvent.click(screen.getByTestId('manual-new-category-button'));
      const input = screen.getByTestId('new-category-input');
      expect(input).toHaveValue('');
      await userEvent.type(input, 'AI Services');
      fireEvent.click(screen.getByTestId('import-button'));

      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalled();
      });
      const payload = vi.mocked(importApi.confirmImport).mock.calls[0][0];
      expect(payload.movements[0].new_category_name).toBe('AI Services');
      expect(payload.movements[0].category_id).toBeUndefined();
    });

    it('clears the AI suggested badge when the suggested name is edited', async () => {
      await goToReviewWith([suggestionMovement]);
      fireEvent.change(screen.getByTestId('new-category-input'), {
        target: { value: 'Software Tools' },
      });
      expect(screen.queryByTestId('new-category-ai-badge')).not.toBeInTheDocument();
      expect(screen.getByTestId('new-category-input')).toHaveValue('Software Tools');
    });

    it('reverts to the category select via the toggle', async () => {
      await goToReviewWith([suggestionMovement]);
      fireEvent.click(screen.getByTestId('new-category-toggle'));
      expect(screen.queryByTestId('new-category-input')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    });

    it('reverts to the category select when the text is cleared', async () => {
      await goToReviewWith([suggestionMovement]);
      fireEvent.change(screen.getByTestId('new-category-input'), { target: { value: '' } });
      expect(screen.queryByTestId('new-category-input')).not.toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    });

    it('sends new_category_name without category_id in the confirm payload', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith([suggestionMovement]);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalled();
      });
      const payload = vi.mocked(importApi.confirmImport).mock.calls[0][0];
      expect(payload.movements[0].new_category_name).toBe('Software');
      expect(payload.movements[0].category_id).toBeUndefined();
    });

    it('switches the cell to a text input when the debounced suggestion returns a new category name', async () => {
      vi.mocked(suggestApi.suggestCategory).mockResolvedValue({
        categoryId: null,
        suggestedNewCategory: 'Travel',
      });
      await goToReviewWith([{ ...mockExtractResponse.movements[0], categoryId: null, categoryName: null, color: null, aiSuggested: false }]);
      vi.useFakeTimers();
      fireEvent.change(screen.getByRole('textbox', { name: 'Store' }), {
        target: { value: 'Despegar' },
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      vi.useRealTimers();
      expect(screen.getByTestId('new-category-input')).toHaveValue('Travel');
      expect(screen.getByTestId('new-category-ai-badge')).toBeInTheDocument();
    });

    it('does not let a late suggestion overwrite the new-category text input', async () => {
      vi.mocked(suggestApi.suggestCategory).mockResolvedValue({
        categoryId: 1,
        categoryName: 'Food',
        color: '#ef4444',
      });
      await goToReviewWith([suggestionMovement]);
      expect(screen.getByTestId('new-category-input')).toHaveValue('Software');
      vi.useFakeTimers();
      fireEvent.change(screen.getByRole('textbox', { name: 'Store' }), {
        target: { value: 'OpenRouter Inc' },
      });
      await act(async () => {
        vi.advanceTimersByTime(400);
        await Promise.resolve();
        await Promise.resolve();
      });
      vi.useRealTimers();
      // The suggestion matched a category, but the cell is in text mode — keep the text
      expect(screen.getByTestId('new-category-input')).toHaveValue('Software');
      expect(screen.queryByRole('combobox', { name: 'Category' })).not.toBeInTheDocument();
    });

    it('shows newly created categories with color swatches in the success summary', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue({
        created: [
          {
            id: 102,
            amount: '25.00',
            date: '2026-06-09',
            description: 'AI credits',
            store: 'OPENROUTER, INC',
            category_id: 9,
            payment_method_id: null,
          },
        ],
        count: 1,
        resolvedCategories: [{ id: 9, name: 'Software', color: '#a855f7', created: true }],
      });
      await goToReviewWith([suggestionMovement]);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      const summary = screen.getByTestId('new-categories-summary');
      expect(summary).toHaveTextContent('Software');
      expect(screen.getByTestId('new-category-swatch')).toHaveStyle({
        backgroundColor: '#a855f7',
      });
    });

    it('omits the new categories block when no categories were created', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith(mockExtractResponse.movements);
      fireEvent.click(screen.getByTestId('import-button'));
      await waitFor(() => {
        expect(screen.getByTestId('success-summary')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('new-categories-summary')).not.toBeInTheDocument();
    });
  });

  describe('Amount suspect flag', () => {
    const suspectMovement: importApi.ExtractedMovement = {
      amount: 40313,
      rawAmountText: '40,313',
      amountSuspect: true,
      date: '2026-06-09',
      description: 'API credits',
      store: 'OPENROUTER, INC',
      categoryId: 1,
      categoryName: 'Food',
      color: '#ef4444',
      aiSuggested: true,
      suggestedNewCategory: null,
      ...noPayment,
    };

    async function goToReviewWith(movements: importApi.ExtractResponse['movements']) {
      vi.mocked(importApi.extractFromImage).mockResolvedValue({
        ...mockExtractResponse,
        movements,
      });
      renderImport();
      const input = screen.getByTestId('file-input');
      await userEvent.upload(input, mockFile);
      fireEvent.click(screen.getByTestId('process-button'));
      await waitFor(() => {
        expect(screen.getByTestId('movements-table')).toBeInTheDocument();
      });
    }

    it('shows a warning icon beside the amount when amountSuspect is true', async () => {
      await goToReviewWith([suspectMovement]);
      const warning = screen.getByTestId('amount-suspect-warning');
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveAttribute('title', 'Receipt shows "40,313" — please verify');
    });

    it('does not show the warning when amountSuspect is false', async () => {
      await goToReviewWith([
        { ...suspectMovement, amountSuspect: false, rawAmountText: '40,313' },
      ]);
      expect(screen.queryByTestId('amount-suspect-warning')).not.toBeInTheDocument();
    });

    it('does not show the warning for movements without the suspect fields', async () => {
      await goToReviewWith(mockExtractResponse.movements);
      expect(screen.queryByTestId('amount-suspect-warning')).not.toBeInTheDocument();
    });

    it('clears the warning when the amount is edited manually', async () => {
      await goToReviewWith([suspectMovement]);
      expect(screen.getByTestId('amount-suspect-warning')).toBeInTheDocument();
      const amountInput = screen.getByRole('spinbutton', { name: /amount/i });
      await userEvent.clear(amountInput);
      await userEvent.type(amountInput, '40313');
      expect(screen.queryByTestId('amount-suspect-warning')).not.toBeInTheDocument();
    });

    it('does not block confirmation for suspect rows', async () => {
      vi.mocked(importApi.confirmImport).mockResolvedValue(mockConfirmResponse);
      await goToReviewWith([suspectMovement]);
      const importButton = screen.getByTestId('import-button');
      expect(importButton).not.toBeDisabled();
      fireEvent.click(importButton);
      await waitFor(() => {
        expect(importApi.confirmImport).toHaveBeenCalledWith(
          expect.objectContaining({
            movements: expect.arrayContaining([
              expect.objectContaining({ amount: 40313 }),
            ]),
          })
        );
      });
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
