import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GmailSettings } from '../pages/GmailSettings';
import * as gmailApi from '../api/gmail';

vi.mock('../api/gmail');

const connectedStatus: gmailApi.GmailStatus = {
  connected: true,
  email: 'me@example.com',
  connectedAt: '2026-06-01T12:00:00.000Z',
};

const disconnectedStatus: gmailApi.GmailStatus = {
  connected: false,
  email: null,
  connectedAt: null,
};

const sender: gmailApi.GmailSender = {
  id: 7,
  email: 'alertas@davibank.com',
  label: 'DAVIbank alerts',
  subject_contains: 'Alerta de compra',
  created_at: '2026-06-01T00:00:00.000Z',
};

function renderPage(path = '/settings/gmail') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/gmail" element={<GmailSettings />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('GmailSettings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      value: { assign: vi.fn() },
      writable: true,
    });
  });

  it('renders the disconnected state and starts the OAuth flow', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(disconnectedStatus);
    vi.mocked(gmailApi.getGmailAuthUrl).mockResolvedValue('https://accounts.google.com/auth');
    renderPage();

    expect(await screen.findByText(/import movements from your bank notification emails/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /connect gmail/i }));

    expect(gmailApi.getGmailAuthUrl).toHaveBeenCalled();
    expect(window.location.assign).toHaveBeenCalledWith('https://accounts.google.com/auth');
  });

  it('renders connected account details and disconnects after confirmation', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValue([sender]);
    vi.mocked(gmailApi.disconnectGmail).mockResolvedValue();
    renderPage();

    expect(await screen.findByText('me@example.com')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(gmailApi.disconnectGmail).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /connect gmail/i })).toBeInTheDocument();
  });

  it('handles OAuth return success and cleans the query string', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValue([]);
    renderPage('/settings/gmail?gmail=connected');

    expect(await screen.findByRole('status')).toHaveTextContent(/gmail connected/i);
  });

  it('handles OAuth return errors', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(disconnectedStatus);
    renderPage('/settings/gmail?gmail=error&reason=no_refresh_token');

    expect(await screen.findByRole('alert')).toHaveTextContent(/no_refresh_token/i);
  });

  it('renders sender list and the zero-sender prompt', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValueOnce([]);
    renderPage();

    expect(await screen.findByText(/add the addresses your bank sends purchase alerts from/i)).toBeInTheDocument();

    vi.clearAllMocks();
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValueOnce([sender]);
    renderPage();

    expect(await screen.findByText('alertas@davibank.com')).toBeInTheDocument();
    expect(screen.getByText('DAVIbank alerts')).toBeInTheDocument();
    expect(screen.getByText(/subject contains "Alerta de compra"/i)).toBeInTheDocument();
  });

  it('adds a sender with client validation and duplicate handling', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValue([]);
    vi.mocked(gmailApi.createGmailSender)
      .mockRejectedValueOnce({ message: 'duplicate', status: 409 })
      .mockResolvedValueOnce(sender);
    renderPage();
    await screen.findByLabelText(/sender email/i);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/sender email/i), 'bad-address');
    await user.click(screen.getByRole('button', { name: /add sender/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid email/i);
    expect(gmailApi.createGmailSender).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/sender email/i));
    await user.type(screen.getByLabelText(/sender email/i), 'alertas@davibank.com');
    await user.type(screen.getByLabelText(/sender label/i), 'DAVIbank alerts');
    await user.type(screen.getByLabelText(/subject contains/i), 'Alerta de compra');
    await user.click(screen.getByRole('button', { name: /add sender/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);

    await user.click(screen.getByRole('button', { name: /add sender/i }));
    expect(await screen.findByText('alertas@davibank.com')).toBeInTheDocument();
  });

  it('deletes a sender after confirmation', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockResolvedValue(connectedStatus);
    vi.mocked(gmailApi.getGmailSenders).mockResolvedValue([sender]);
    vi.mocked(gmailApi.deleteGmailSender).mockResolvedValue();
    renderPage();
    expect(await screen.findByText('alertas@davibank.com')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /delete alertas@davibank.com/i }));
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(gmailApi.deleteGmailSender).toHaveBeenCalledWith(7));
    expect(screen.queryByText('alertas@davibank.com')).not.toBeInTheDocument();
  });

  it('shows a reconnect banner for Gmail auth failures', async () => {
    vi.mocked(gmailApi.getGmailStatus).mockRejectedValue(
      { message: 'Reconnect required', status: 401, code: 'GMAIL_RECONNECT_REQUIRED' }
    );
    vi.mocked(gmailApi.getGmailAuthUrl).mockResolvedValue('https://accounts.google.com/reconnect');
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/needs to be reconnected/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /reconnect/i }));

    expect(window.location.assign).toHaveBeenCalledWith('https://accounts.google.com/reconnect');
  });
});
