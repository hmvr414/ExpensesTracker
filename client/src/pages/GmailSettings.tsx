import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  GmailSender,
  GmailStatus,
  createGmailSender,
  deleteGmailSender,
  disconnectGmail,
  getGmailAuthUrl,
  getGmailSenders,
  getGmailStatus,
  updateGmailSender,
} from '../api/gmail';

function formatConnectedAt(value: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function formatLastPolledAt(value: string | null | undefined): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function isReconnectError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'GMAIL_RECONNECT_REQUIRED'
  );
}

function isConflictError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: number }).status === 409
  );
}

function DeleteConfirm({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute right-0 top-8 z-10 w-56 rounded-lg border border-neutral-200 bg-white p-3 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
      <p className="mb-3 text-sm text-neutral-700 dark:text-neutral-300">{label}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="flex-1 rounded bg-danger-600 px-2 py-1 text-xs text-white hover:bg-danger-700"
        >
          Confirm
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded bg-neutral-200 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function SenderRow({
  sender,
  onUpdated,
  onDeleted,
}: {
  sender: GmailSender;
  onUpdated: (sender: GmailSender) => void;
  onDeleted: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(sender.label ?? '');
  const [subject, setSubject] = useState(sender.subject_contains ?? '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  async function saveEdit() {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await updateGmailSender(sender.id, {
        label: label.trim() || null,
        subject_contains: subject.trim() || null,
      });
      onUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    await deleteGmailSender(sender.id);
    onDeleted(sender.id);
    setConfirmingDelete(false);
  }

  return (
    <li className="flex items-start gap-3 rounded-lg border border-neutral-100 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-neutral-900 dark:text-white">
            {sender.email}
          </span>
          {sender.label && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
              {sender.label}
            </span>
          )}
          {sender.subject_contains && (
            <span className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-700 dark:bg-primary-900/40 dark:text-primary-300">
              subject contains "{sender.subject_contains}"
            </span>
          )}
        </div>
        {editing && (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label"
              aria-label={`Label for ${sender.email}`}
              className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
            />
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject contains"
              aria-label={`Subject contains for ${sender.email}`}
              className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
            />
            <button
              type="button"
              onClick={saveEdit}
              disabled={saving}
              className="w-fit rounded bg-primary-600 px-3 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:bg-neutral-300 dark:disabled:bg-neutral-600"
            >
              Save
            </button>
          </div>
        )}
      </div>
      <div className="relative flex items-center gap-1">
        <button
          type="button"
          aria-label={`Edit ${sender.email}`}
          onClick={() => setEditing((current) => !current)}
          className="rounded p-1 text-neutral-400 hover:text-primary-600 dark:hover:text-primary-400"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={`Delete ${sender.email}`}
          onClick={() => setConfirmingDelete(true)}
          className="rounded p-1 text-neutral-400 hover:text-danger-600 dark:hover:text-danger-400"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
        {confirmingDelete && (
          <DeleteConfirm
            label="Delete this sender?"
            onConfirm={handleDelete}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}
      </div>
    </li>
  );
}

function SenderForm({ onCreated }: { onCreated: (sender: GmailSender) => void }) {
  const [email, setEmail] = useState('');
  const [label, setLabel] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()), [email]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!emailValid) {
      setError('Enter a valid email address');
      return;
    }
    setSubmitting(true);
    try {
      const input = {
        email: email.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(subject.trim() ? { subject_contains: subject.trim() } : {}),
      };
      const created = await createGmailSender(input);
      onCreated(created);
      setEmail('');
      setLabel('');
      setSubject('');
    } catch (err) {
      if (isConflictError(err)) {
        setError('A sender with this email already exists');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Could not add sender');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800"
    >
      <h2 className="mb-3 text-sm font-semibold text-neutral-700 dark:text-neutral-200">
        Add Sender
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="alertas@davibank.com"
          aria-label="Sender email"
          className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
        />
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="DAVIbank alerts"
          aria-label="Sender label"
          className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
        />
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Alerta de compra"
          aria-label="Subject contains"
          className="rounded border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-600 dark:bg-neutral-700 dark:text-white"
        />
      </div>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        Leave subject empty to list every email from this sender
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger-600 dark:text-danger-400">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="mt-3 rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:bg-neutral-300 dark:disabled:bg-neutral-600"
      >
        Add Sender
      </button>
    </form>
  );
}

export function GmailSettings() {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [senders, setSenders] = useState<GmailSender[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  async function load() {
    setLoading(true);
    try {
      const nextStatus = await getGmailStatus();
      setStatus(nextStatus);
      setReconnectRequired(nextStatus.needsReconnect ?? false);
      if (nextStatus.connected) setSenders(await getGmailSenders());
      else setSenders([]);
    } catch (err) {
      if (isReconnectError(err)) setReconnectRequired(true);
      else if (err instanceof Error) setBanner(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const gmail = searchParams.get('gmail');
    const reason = searchParams.get('reason');
    if (gmail === 'connected') setToast('Gmail connected');
    if (gmail === 'error') setBanner(reason ? `Gmail connection failed: ${reason}` : 'Gmail connection failed');
    if (gmail) navigate('/settings/gmail', { replace: true });
  }, [navigate, searchParams]);

  useEffect(() => {
    load();
  }, []);

  async function handleConnect() {
    const url = await getGmailAuthUrl();
    window.location.assign(url);
  }

  async function handleDisconnect() {
    await disconnectGmail();
    setStatus({ connected: false, email: null, connectedAt: null });
    setSenders([]);
    setDisconnectConfirm(false);
  }

  function handleSenderCreated(sender: GmailSender) {
    setSenders((prev) => [...prev, sender].sort((a, b) => a.email.localeCompare(b.email)));
  }

  function handleSenderUpdated(sender: GmailSender) {
    setSenders((prev) =>
      prev.map((item) => (item.id === sender.id ? sender : item)).sort((a, b) => a.email.localeCompare(b.email))
    );
  }

  function handleSenderDeleted(id: number) {
    setSenders((prev) => prev.filter((sender) => sender.id !== id));
  }

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <h1 className="mb-6 text-2xl font-semibold text-neutral-900 dark:text-white">
        Gmail Settings
      </h1>

      {toast && (
        <div role="status" className="mb-4 rounded-lg border border-success-200 bg-success-50 p-3 text-sm text-success-700 dark:border-success-900 dark:bg-success-900/30 dark:text-success-300">
          {toast}
        </div>
      )}
      {(banner || reconnectRequired) && (
        <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-800 dark:border-warning-900 dark:bg-warning-900/30 dark:text-warning-200">
          <span>{reconnectRequired ? 'Gmail needs to be reconnected' : banner}</span>
          {reconnectRequired && (
            <button
              type="button"
              onClick={handleConnect}
              className="rounded bg-warning-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-warning-700"
            >
              Reconnect
            </button>
          )}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-700 dark:bg-neutral-800">
        {loading ? (
          <div data-testid="gmail-settings-loading" className="h-20 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
        ) : status?.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Connected to Gmail
              </h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{status.email}</p>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Connected since {formatConnectedAt(status.connectedAt)}
              </p>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                Last checked: {formatLastPolledAt(status.lastPolledAt)}
              </p>
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => setDisconnectConfirm(true)}
                className="rounded border border-danger-200 px-4 py-2 text-sm font-medium text-danger-700 hover:bg-danger-50 dark:border-danger-900 dark:text-danger-300 dark:hover:bg-danger-900/20"
              >
                Disconnect
              </button>
              {disconnectConfirm && (
                <DeleteConfirm
                  label="Disconnect Gmail?"
                  onConfirm={handleDisconnect}
                  onCancel={() => setDisconnectConfirm(false)}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-neutral-900 dark:text-white">
                Import movements from your bank notification emails
              </h2>
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
                Connect Gmail to browse matching bank alerts for import.
              </p>
            </div>
            <button
              type="button"
              onClick={handleConnect}
              className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
            >
              Connect Gmail
            </button>
          </div>
        )}
      </section>

      {status?.connected && (
        <section>
          {senders.length === 0 && (
            <div className="mb-4 rounded-lg border border-primary-200 bg-primary-50 p-4 text-sm font-medium text-primary-900 dark:border-primary-800 dark:bg-primary-900/30 dark:text-primary-100">
              Add the addresses your bank sends purchase alerts from
            </div>
          )}
          <SenderForm onCreated={handleSenderCreated} />
          <ul className="flex flex-col gap-2">
            {senders.map((sender) => (
              <SenderRow
                key={sender.id}
                sender={sender}
                onUpdated={handleSenderUpdated}
                onDeleted={handleSenderDeleted}
              />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
