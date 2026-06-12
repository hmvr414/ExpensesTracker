import { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import { Category, ResolvedCategory, getCategories } from '../api/categories';
import {
  extractFromImage,
  extractFromEmails,
  confirmImport,
  ExtractEmailResult,
  ExtractedMovement,
  ConfirmResponse,
} from '../api/import';
import { suggestCategory } from '../api/suggest';
import {
  GmailApiError,
  GmailMessage,
  GmailPendingEmail,
  GmailSender,
  dismissGmailPending,
  getGmailMessages,
  getGmailPending,
  getGmailSenders,
  getGmailStatus,
  pollGmailNow,
  requestGmailPendingRefresh,
  retryGmailPending,
} from '../api/gmail';
import {
  PaymentMethod,
  PaymentMethodBrand,
  getPaymentMethods,
  createPaymentMethod,
} from '../api/paymentMethods';
import { paymentMethodIcon } from '../helpers/paymentMethod';

type Step = 'upload' | 'processing' | 'review' | 'confirm';
type SourceTab = 'upload' | 'gmail';
type GmailPreset = 'this-week' | 'this-month' | 'last-week' | 'last-month' | 'last-30-days' | 'custom';

interface ReviewRow {
  _key: string;
  amount: string;
  // Amount string as it appeared on the receipt; shown in the ⚠ tooltip
  // when the server flagged the parsed amount as suspect
  rawAmountText: string | null;
  amountSuspect: boolean;
  date: string;
  time: string;
  description: string;
  store: string;
  possibleDuplicate: boolean;
  duplicateOf: {
    id: number | null;
    date: string;
    time: string | null;
    description: string | null;
  } | null;
  categoryId: number | null;
  categoryName: string | null;
  color: string | null;
  // Non-null switches the Category cell to a free-text "new category" input
  newCategoryName: string | null;
  aiSuggested: boolean;
  suggestLoading: boolean;
  paymentMethodId: number | null;
  paymentAiSuggested: boolean;
  detectedPaymentLabel: string | null;
  detectedBrand: string | null;
  detectedVariant: string | null;
  registering: boolean;
  registerError: string | null;
  // Set for gmail-sourced rows: traceability column + dedup on confirm
  gmailMessageId: string | null;
  emailSubject: string | null;
  emailFrom: string | null;
  emailDate: string | null;
  // Marked by a 409 confirm response; row is skipped on the next confirm
  alreadyImported: boolean;
}

let keyCounter = 0;
function makeKey() {
  return String(++keyCounter);
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date: Date) {
  const copy = new Date(date);
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function dateRangeForPreset(preset: GmailPreset) {
  const today = new Date();
  const from = new Date(today);
  const to = new Date(today);

  if (preset === 'this-week') {
    return { from: toDateInputValue(startOfWeek(today)), to: toDateInputValue(to) };
  }
  if (preset === 'this-month') {
    return { from: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)), to: toDateInputValue(to) };
  }
  if (preset === 'last-week') {
    const end = startOfWeek(today);
    end.setDate(end.getDate() - 1);
    const start = startOfWeek(end);
    return { from: toDateInputValue(start), to: toDateInputValue(end) };
  }
  if (preset === 'last-month') {
    return {
      from: toDateInputValue(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  }

  from.setDate(from.getDate() - 29);
  return { from: toDateInputValue(from), to: toDateInputValue(to) };
}

function movementToRow(
  m: ExtractedMovement,
  email?: Pick<ExtractEmailResult, 'messageId' | 'subject' | 'from' | 'date'>
): ReviewRow {
  const suggestedNew = m.categoryId == null ? m.suggestedNewCategory ?? null : null;
  return {
    _key: makeKey(),
    amount: String(m.amount),
    rawAmountText: m.rawAmountText ?? null,
    amountSuspect: m.amountSuspect ?? false,
    date: m.date,
    time: m.time ?? '',
    description: m.description ?? '',
    store: m.store ?? '',
    possibleDuplicate: m.possibleDuplicate ?? false,
    duplicateOf: m.duplicateOf ?? null,
    categoryId: m.categoryId,
    categoryName: m.categoryName ?? null,
    color: m.color ?? null,
    newCategoryName: suggestedNew,
    aiSuggested: m.aiSuggested || suggestedNew != null,
    suggestLoading: false,
    paymentMethodId: m.paymentMethodId ?? null,
    paymentAiSuggested: m.paymentAiSuggested ?? false,
    detectedPaymentLabel: m.detectedPaymentLabel ?? null,
    detectedBrand: m.detectedBrand ?? null,
    detectedVariant: m.detectedVariant ?? null,
    registering: false,
    registerError: null,
    gmailMessageId: email?.messageId ?? m.gmailMessageId ?? null,
    emailSubject: email?.subject ?? null,
    emailFrom: email?.from ?? null,
    emailDate: email?.date ?? null,
    alreadyImported: false,
  };
}

function emptyRow(): ReviewRow {
  return {
    _key: makeKey(),
    amount: '',
    rawAmountText: null,
    amountSuspect: false,
    date: new Date().toISOString().split('T')[0],
    time: '',
    description: '',
    store: '',
    possibleDuplicate: false,
    duplicateOf: null,
    categoryId: null,
    categoryName: null,
    color: null,
    newCategoryName: null,
    aiSuggested: false,
    suggestLoading: false,
    paymentMethodId: null,
    paymentAiSuggested: false,
    detectedPaymentLabel: null,
    detectedBrand: null,
    detectedVariant: null,
    registering: false,
    registerError: null,
    gmailMessageId: null,
    emailSubject: null,
    emailFrom: null,
    emailDate: null,
    alreadyImported: false,
  };
}

function ProcessingStageItem({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${done ? 'opacity-50' : ''}`}>
      {done ? (
        <span className="w-5 h-5 rounded-full bg-success-500 flex items-center justify-center text-white text-xs">✓</span>
      ) : active ? (
        <span className="w-5 h-5 rounded-full border-2 border-primary-500 border-t-transparent animate-spin" />
      ) : (
        <span className="w-5 h-5 rounded-full border-2 border-neutral-300 dark:border-neutral-600" />
      )}
      <span className={`text-sm ${active ? 'text-neutral-900 dark:text-white font-medium' : 'text-neutral-500'}`}>
        {label}
      </span>
    </div>
  );
}

interface ReviewRowProps {
  row: ReviewRow;
  categories: Category[];
  paymentMethods: PaymentMethod[];
  showSource: boolean;
  onAmountChange: (val: string) => void;
  onDateChange: (val: string) => void;
  onTimeChange: (val: string) => void;
  onDescriptionChange: (val: string) => void;
  onStoreChange: (val: string) => void;
  onCategoryChange: (id: number | null, name: string | null, color: string | null) => void;
  onUseNewCategory: () => void;
  onNewCategoryNameChange: (val: string) => void;
  onRevertToSelect: () => void;
  onPaymentMethodChange: (id: number | null) => void;
  onRegisterCard: () => void;
  onRemove: () => void;
}

function ReviewRowComponent({
  row,
  categories,
  paymentMethods,
  showSource,
  onAmountChange,
  onDateChange,
  onTimeChange,
  onDescriptionChange,
  onStoreChange,
  onCategoryChange,
  onUseNewCategory,
  onNewCategoryNameChange,
  onRevertToSelect,
  onPaymentMethodChange,
  onRegisterCard,
  onRemove,
}: ReviewRowProps) {
  return (
    <tr
      className={`border-b border-neutral-100 dark:border-neutral-800 ${
        row.alreadyImported ? 'opacity-50' : ''
      }`}
    >
      <td className="py-1 px-2">
        <div className="flex items-center gap-1">
          <input
            type="number"
            value={row.amount}
            onChange={(e) => onAmountChange(e.target.value)}
            placeholder="0.00"
            aria-label="Amount"
            className="w-24 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
          />
          {row.amountSuspect && (
            <span
              data-testid="amount-suspect-warning"
              title={`Receipt shows "${row.rawAmountText}" — please verify`}
              className="text-warning-600 cursor-help"
            >
              ⚠
            </span>
          )}
        </div>
      </td>
      <td className="py-1 px-2">
        <input
          type="date"
          value={row.date}
          onChange={(e) => onDateChange(e.target.value)}
          aria-label="Date"
          className="border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
        />
      </td>
      <td className="py-1 px-2">
        <input
          type="time"
          value={row.time}
          onChange={(e) => onTimeChange(e.target.value)}
          aria-label="Time"
          className="w-24 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
        />
      </td>
      <td className="py-1 px-2">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={row.description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Description"
            aria-label="Description"
            className="w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white min-w-32"
          />
          {row.possibleDuplicate && (
            <span
              data-testid="possible-duplicate-badge"
              title={
                row.duplicateOf?.id
                  ? `Looks like movement #${row.duplicateOf.id} — same store, amount and date`
                  : 'Looks like another row in this import — same store, amount and date'
              }
              className="rounded-full bg-warning-100 dark:bg-warning-900/30 px-2 py-0.5 text-xs text-warning-800 dark:text-warning-300 whitespace-nowrap cursor-help"
            >
              Possible duplicate
            </span>
          )}
        </div>
      </td>
      <td className="py-1 px-2">
        <input
          type="text"
          value={row.store}
          onChange={(e) => onStoreChange(e.target.value)}
          placeholder="Store"
          aria-label="Store"
          className="w-32 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
        />
      </td>
      <td className="py-1 px-2">
        {row.newCategoryName !== null ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={row.newCategoryName}
              onChange={(e) => onNewCategoryNameChange(e.target.value)}
              maxLength={40}
              aria-label="New category name"
              data-testid="new-category-input"
              className="w-32 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
            />
            <button
              type="button"
              onClick={onRevertToSelect}
              aria-label="Choose existing category"
              title="Choose an existing category instead"
              data-testid="new-category-toggle"
              className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors leading-none"
            >
              ⌄
            </button>
            {row.aiSuggested && (
              <span
                data-testid="new-category-ai-badge"
                className="text-xs text-primary-600 font-medium whitespace-nowrap"
              >
                ✦ AI suggested
              </span>
            )}
          </div>
        ) : (
        <div className="flex items-center gap-1">
          <select
            value={row.categoryId ?? ''}
            onChange={(e) => {
              const val = e.target.value;
              if (!val) {
                onCategoryChange(null, null, null);
              } else {
                const cat = categories.find((c) => c.id === Number(val));
                onCategoryChange(Number(val), cat?.name ?? null, cat?.color ?? null);
              }
            }}
            aria-label="Category"
            className="border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onUseNewCategory}
            aria-label="Type a new category"
            title="Type a new category"
            data-testid="manual-new-category-button"
            className="text-xs text-primary-600 hover:text-primary-700 font-medium whitespace-nowrap"
          >
            + New
          </button>
          {row.suggestLoading && (
            <span
              className="w-4 h-4 border-2 border-primary-500 border-t-transparent rounded-full animate-spin"
              aria-label="Suggesting category..."
            />
          )}
          {row.aiSuggested && !row.suggestLoading && (
            <span
              data-testid="ai-badge"
              className="text-xs text-primary-600 font-medium whitespace-nowrap"
            >
              ✦ AI
            </span>
          )}
        </div>
        )}
      </td>
      <td className="py-1 px-2">
        <div className="flex items-center gap-1">
          <select
            value={row.paymentMethodId ?? ''}
            onChange={(e) => onPaymentMethodChange(e.target.value ? Number(e.target.value) : null)}
            aria-label="Paid with"
            className="border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
          >
            <option value="">No payment method</option>
            {paymentMethods.map((pm) => (
              <option key={pm.id} value={pm.id}>
                {paymentMethodIcon(pm.kind)} {pm.name}
              </option>
            ))}
          </select>
          {row.paymentAiSuggested && (
            <span
              data-testid="payment-ai-badge"
              className="text-xs text-primary-600 font-medium whitespace-nowrap"
            >
              ✦ AI detected
            </span>
          )}
        </div>
        {row.detectedPaymentLabel && row.paymentMethodId == null && (
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
            Detected "{row.detectedPaymentLabel}" —{' '}
            <button
              type="button"
              onClick={onRegisterCard}
              disabled={row.registering}
              data-testid="register-card-button"
              className="text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
            >
              {row.registering ? 'Registering...' : 'Register this card?'}
            </button>
            {row.registerError && (
              <p data-testid="register-card-error" className="mt-0.5 text-danger-600">
                {row.registerError}
              </p>
            )}
          </div>
        )}
      </td>
      {showSource && (
        <td className="py-1 px-2">
          {row.gmailMessageId && (
            <div className="flex items-center gap-1.5">
              <span
                data-testid="source-cell"
                title={[
                  row.emailFrom,
                  row.emailDate ? new Date(row.emailDate).toLocaleString() : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                className="inline-block max-w-36 truncate align-middle text-xs text-neutral-500 dark:text-neutral-400 cursor-help"
              >
                {row.emailSubject || row.gmailMessageId}
              </span>
              {row.alreadyImported && (
                <span
                  data-testid="already-imported-badge"
                  className="rounded-full bg-warning-100 dark:bg-warning-900/30 px-2 py-0.5 text-xs text-warning-800 dark:text-warning-300 whitespace-nowrap"
                >
                  Already imported
                </span>
              )}
            </div>
          )}
        </td>
      )}
      <td className="py-1 px-2">
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove row"
          data-testid="remove-row-button"
          className="text-neutral-400 hover:text-danger-600 transition-colors text-lg leading-none"
        >
          ×
        </button>
      </td>
    </tr>
  );
}

export function Import() {
  const [step, setStep] = useState<Step>('upload');
  const [sourceTab, setSourceTab] = useState<SourceTab>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processingStage, setProcessingStage] = useState<'extracting' | 'analyzing'>('extracting');
  const [rawText, setRawText] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [attachmentId, setAttachmentId] = useState<number | undefined>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [created, setCreated] = useState<ConfirmResponse['created'] | null>(null);
  const [resolvedCategories, setResolvedCategories] = useState<ResolvedCategory[]>([]);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [gmailNeedsReconnect, setGmailNeedsReconnect] = useState(false);
  const [gmailLastPolledAt, setGmailLastPolledAt] = useState<string | null>(null);
  const [gmailSenders, setGmailSenders] = useState<GmailSender[]>([]);
  const [gmailSetupLoading, setGmailSetupLoading] = useState(false);
  const [gmailSetupError, setGmailSetupError] = useState<string | null>(null);
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [gmailMessagesLoading, setGmailMessagesLoading] = useState(false);
  const [gmailMessagesError, setGmailMessagesError] = useState<string | null>(null);
  const [gmailNextPageToken, setGmailNextPageToken] = useState<string | null>(null);
  const [gmailSelected, setGmailSelected] = useState<Set<string>>(new Set());
  const [gmailPreset, setGmailPreset] = useState<GmailPreset>('last-30-days');
  const initialRange = useRef(dateRangeForPreset('last-30-days'));
  const [gmailFrom, setGmailFrom] = useState(initialRange.current.from);
  const [gmailTo, setGmailTo] = useState(initialRange.current.to);
  const [gmailSender, setGmailSender] = useState('');
  const [gmailSubjectInput, setGmailSubjectInput] = useState('');
  const [gmailSubject, setGmailSubject] = useState('');
  const [gmailExtracting, setGmailExtracting] = useState(false);
  const [gmailEmailErrors, setGmailEmailErrors] = useState<ExtractEmailResult[]>([]);
  const [pendingEmails, setPendingEmails] = useState<GmailPendingEmail[]>([]);
  const [pendingErrorEmails, setPendingErrorEmails] = useState<GmailPendingEmail[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [pendingSelected, setPendingSelected] = useState<Set<string>>(new Set());
  const [pendingRetrying, setPendingRetrying] = useState<string | null>(null);
  const [pollingNow, setPollingNow] = useState(false);
  const [reviewSource, setReviewSource] = useState<SourceTab>('upload');
  const [importedEmailCount, setImportedEmailCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const stageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
    getPaymentMethods().then(setPaymentMethods).catch(() => {});
  }, []);

  useEffect(() => {
    if (sourceTab !== 'gmail') return;
    let cancelled = false;
    setGmailSetupLoading(true);
    setGmailSetupError(null);
    Promise.all([getGmailStatus(), getGmailSenders()])
      .then(([status, senders]) => {
        if (cancelled) return;
        setGmailConnected(status.connected);
        setGmailNeedsReconnect(status.needsReconnect ?? false);
        setGmailLastPolledAt(status.lastPolledAt ?? null);
        setGmailSenders(senders);
      })
      .catch((err) => {
        if (cancelled) return;
        setGmailSetupError(err instanceof Error ? err.message : 'Could not load Gmail settings.');
        setGmailConnected(false);
        setGmailSenders([]);
      })
      .finally(() => {
        if (!cancelled) setGmailSetupLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceTab]);

  useEffect(() => {
    if (sourceTab !== 'gmail') return;
    const timer = setTimeout(() => setGmailSubject(gmailSubjectInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [gmailSubjectInput, sourceTab]);

  useEffect(() => {
    if (sourceTab !== 'gmail' || gmailConnected !== true || gmailSenders.length === 0) return;
    void loadGmailMessages(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTab, gmailConnected, gmailSenders.length, gmailFrom, gmailTo, gmailSender, gmailSubject]);

  useEffect(() => {
    if (sourceTab !== 'gmail' || gmailConnected !== true || gmailSenders.length === 0) return;
    void loadPendingQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceTab, gmailConnected, gmailSenders.length]);

  useEffect(() => {
    return () => {
      suggestTimers.current.forEach((t) => clearTimeout(t));
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
    };
  }, []);

  async function loadGmailMessages(append: boolean, pageToken?: string) {
    setGmailMessagesLoading(true);
    setGmailMessagesError(null);
    try {
      const result = await getGmailMessages({
        from: gmailFrom,
        to: gmailTo,
        sender: gmailSender || undefined,
        subject: gmailSubject || undefined,
        pageToken,
      });
      setGmailMessages((prev) => (append ? [...prev, ...result.messages] : result.messages));
      setGmailNextPageToken(result.nextPageToken);
      if (!append) setGmailSelected(new Set());
    } catch (err) {
      const reconnect =
        err instanceof GmailApiError && err.code === 'GMAIL_RECONNECT_REQUIRED'
          ? 'Reconnect Gmail to keep importing emails.'
          : null;
      setGmailMessagesError(reconnect ?? (err instanceof Error ? err.message : 'Could not load Gmail messages.'));
      if (!append) setGmailMessages([]);
    } finally {
      setGmailMessagesLoading(false);
    }
  }

  async function loadPendingQueue() {
    setPendingLoading(true);
    setPendingError(null);
    try {
      const [pending, errors] = await Promise.all([
        getGmailPending('pending'),
        getGmailPending('error'),
      ]);
      setPendingEmails(pending.emails);
      setPendingErrorEmails(errors.emails);
      setPendingSelected((prev) => {
        const available = new Set(pending.emails.map((email) => email.messageId));
        return new Set([...prev].filter((id) => available.has(id)));
      });
      requestGmailPendingRefresh();
    } catch (err) {
      if (err instanceof GmailApiError && err.code === 'GMAIL_RECONNECT_REQUIRED') {
        setGmailNeedsReconnect(true);
        setPendingError('Reconnect Gmail to review pending imports.');
      } else {
        setPendingError(err instanceof Error ? err.message : 'Could not load pending imports.');
      }
    } finally {
      setPendingLoading(false);
    }
  }

  function applyFile(f: File) {
    setFile(f);
    if (f.type !== 'application/pdf') {
      setPreviewUrl(URL.createObjectURL(f));
    } else {
      setPreviewUrl(null);
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) applyFile(f);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) applyFile(f);
  }

  async function handleProcess() {
    if (!file) return;
    setReviewSource('upload');
    setStep('processing');
    setProcessingStage('extracting');

    stageTimerRef.current = setTimeout(() => {
      setProcessingStage('analyzing');
    }, 2000);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const result = await extractFromImage(formData);
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
      setRawText(result.rawText);
      setAttachmentId(result.attachmentId);
      if (result.error) {
        setExtractError(result.error);
        setRows([]);
      } else {
        setExtractError(null);
        setRows(result.movements.map((m) => movementToRow(m)));
      }
      setStep('review');
    } catch {
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
      setExtractError('Failed to process image. Please try again.');
      setRows([]);
      setStep('review');
    }
  }

  function handlePresetChange(preset: GmailPreset) {
    setGmailPreset(preset);
    if (preset !== 'custom') {
      const range = dateRangeForPreset(preset);
      setGmailFrom(range.from);
      setGmailTo(range.to);
    }
  }

  function toggleGmailSelected(id: string) {
    setGmailSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 25) {
        next.add(id);
      }
      return next;
    });
  }

  function selectVisibleGmailMessages() {
    setGmailSelected((prev) => {
      const next = new Set(prev);
      for (const message of gmailMessages) {
        if (next.size >= 25) break;
        if (!message.alreadyImported) next.add(message.id);
      }
      return next;
    });
  }

  function clearGmailSelection() {
    setGmailSelected(new Set());
  }

  async function handleExtractEmails(messageIds?: string[]) {
    const ids = messageIds ?? Array.from(gmailSelected);
    if (ids.length === 0) return;
    setGmailExtracting(true);
    setGmailEmailErrors((prev) => prev.filter((entry) => !ids.includes(entry.messageId)));
    try {
      const result = await extractFromEmails(ids);
      const failed = result.emails.filter((email) => email.error);
      const newRows = result.emails.flatMap((email) =>
        email.error ? [] : email.movements.map((m) => movementToRow(m, email))
      );
      setGmailEmailErrors((prev) => [...prev, ...failed]);
      if (newRows.length > 0) {
        setRows((prev) => [...prev, ...newRows]);
        setRawText('');
        setAttachmentId(undefined);
        setExtractError(null);
        setReviewSource('gmail');
        setStep('review');
      }
      if (failed.length === 0) {
        // Zero movements still moves to review, where the empty state offers
        // a way back to the email list
        setReviewSource('gmail');
        setStep('review');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not extract selected emails.';
      setGmailEmailErrors((prev) => [
        ...prev,
        ...ids.map((id) => ({
          messageId: id,
          movements: [],
          error: message,
        })),
      ]);
    } finally {
      setGmailExtracting(false);
    }
  }

  function togglePendingSelected(id: string) {
    setPendingSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleReviewPending() {
    const selected = pendingEmails.filter((email) => pendingSelected.has(email.messageId));
    if (selected.length === 0) return;
    const nextRows = selected.flatMap((email) =>
      email.movements.map((movement) => movementToRow(movement as ExtractedMovement, email))
    );
    setRows(nextRows);
    setGmailEmailErrors([]);
    setRawText('');
    setAttachmentId(undefined);
    setExtractError(null);
    setReviewSource('gmail');
    setStep('review');
  }

  async function handleDismissPending(messageId: string) {
    if (!window.confirm("Dismiss — this email won't be suggested again?")) return;
    await dismissGmailPending(messageId);
    setPendingEmails((prev) => prev.filter((email) => email.messageId !== messageId));
    setPendingSelected((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      return next;
    });
    requestGmailPendingRefresh();
  }

  async function handleRetryPending(messageId: string) {
    setPendingRetrying(messageId);
    setPendingError(null);
    try {
      await retryGmailPending(messageId);
      await loadPendingQueue();
    } catch (err) {
      if (err instanceof GmailApiError && err.code === 'GMAIL_RECONNECT_REQUIRED') {
        setGmailNeedsReconnect(true);
        setPendingError('Reconnect Gmail to continue importing emails.');
      } else {
        setPendingError(err instanceof Error ? err.message : 'Could not retry this email.');
      }
    } finally {
      setPendingRetrying(null);
    }
  }

  async function handlePollNow() {
    setPollingNow(true);
    setPendingError(null);
    try {
      await pollGmailNow();
      const status = await getGmailStatus();
      setGmailNeedsReconnect(status.needsReconnect ?? false);
      setGmailLastPolledAt(status.lastPolledAt ?? null);
      await loadPendingQueue();
    } catch (err) {
      if (err instanceof GmailApiError && err.code === 'GMAIL_RECONNECT_REQUIRED') {
        setGmailNeedsReconnect(true);
        setPendingError('Reconnect Gmail to continue importing emails.');
      } else {
        setPendingError(err instanceof Error ? err.message : 'Could not check Gmail now.');
      }
    } finally {
      setPollingNow(false);
    }
  }

  function updateRow(key: string, patch: Partial<ReviewRow>) {
    setRows((prev) => prev.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  }

  function scheduleRowSuggest(key: string, store: string, description: string) {
    const existing = suggestTimers.current.get(key);
    if (existing) clearTimeout(existing);
    if (!store.trim() && !description.trim()) return;

    const timer = setTimeout(async () => {
      updateRow(key, { suggestLoading: true });
      try {
        const result = await suggestCategory({
          store: store.trim() || undefined,
          description: description.trim() || undefined,
        });
        setRows((prev) =>
          prev.map((r) => {
            if (r._key !== key) return r;
            // A response landing after the user switched this cell to the
            // new-category text input must not overwrite their text
            if (r.newCategoryName !== null) return { ...r, suggestLoading: false };
            if (result.categoryId != null) {
              return {
                ...r,
                categoryId: result.categoryId,
                categoryName: result.categoryName ?? null,
                color: result.color ?? null,
                aiSuggested: true,
                suggestLoading: false,
              };
            }
            if (result.suggestedNewCategory) {
              return {
                ...r,
                categoryId: null,
                categoryName: null,
                color: null,
                newCategoryName: result.suggestedNewCategory,
                aiSuggested: true,
                suggestLoading: false,
              };
            }
            return { ...r, suggestLoading: false };
          })
        );
      } catch {
        updateRow(key, { suggestLoading: false });
      }
    }, 400);

    suggestTimers.current.set(key, timer);
  }

  function handleRowStoreChange(key: string, value: string) {
    const row = rows.find((r) => r._key === key);
    updateRow(key, { store: value, aiSuggested: false });
    if (row) scheduleRowSuggest(key, value, row.description);
  }

  function handleRowDescriptionChange(key: string, value: string) {
    const row = rows.find((r) => r._key === key);
    updateRow(key, { description: value, aiSuggested: false });
    if (row) scheduleRowSuggest(key, row.store, value);
  }

  function handleRowNewCategoryNameChange(key: string, value: string) {
    // Clearing the text reverts the cell to the existing-categories select
    updateRow(key, { newCategoryName: value === '' ? null : value, aiSuggested: false });
  }

  async function handleRegisterCard(key: string) {
    const row = rows.find((r) => r._key === key);
    if (!row?.detectedPaymentLabel) return;
    updateRow(key, { registering: true, registerError: null });
    try {
      const created = await createPaymentMethod({
        name: row.detectedPaymentLabel,
        kind: 'card',
        brand: (row.detectedBrand as PaymentMethodBrand | null) ?? undefined,
        variant: row.detectedVariant ?? undefined,
      });
      setPaymentMethods((prev) =>
        [...prev, created].sort((a, b) => a.name.localeCompare(b.name))
      );
      updateRow(key, {
        paymentMethodId: created.id,
        detectedPaymentLabel: null,
        detectedBrand: null,
        detectedVariant: null,
        registering: false,
        registerError: null,
      });
    } catch (err) {
      const message =
        axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
          ? err.response.data.error
          : 'Could not register the card. Please try again.';
      updateRow(key, { registering: false, registerError: message });
    }
  }

  function addRow() {
    setRows((prev) => [...prev, emptyRow()]);
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r._key !== key));
  }

  async function handleConfirm() {
    setConfirming(true);
    setConfirmError(null);
    try {
      const confirmable = rows.filter((r) => r.amount.trim() !== '' && !r.alreadyImported);
      const movements = confirmable.map((r) => {
        const base = {
          amount: Number(r.amount),
          date: r.date,
          time: r.time || null,
          description: r.description || undefined,
          store: r.store || undefined,
          payment_method_id: r.paymentMethodId ?? null,
          gmail_message_id: r.gmailMessageId ?? undefined,
        };
        const newName = r.newCategoryName?.trim();
        return newName
          ? { ...base, new_category_name: newName }
          : { ...base, category_id: r.categoryId ?? null };
      });

      const result = await confirmImport({ attachmentId, movements });
      const importedEmailIds = [
        ...new Set(confirmable.flatMap((r) => (r.gmailMessageId ? [r.gmailMessageId] : []))),
      ];
      setImportedEmailCount(importedEmailIds.length);
      if (importedEmailIds.length > 0) {
        // Reflect the new Imported badges in the already-loaded email list
        // without re-fetching from Gmail
        const importedSet = new Set(importedEmailIds);
        setGmailMessages((prev) =>
          prev.map((m) => (importedSet.has(m.id) ? { ...m, alreadyImported: true } : m))
        );
        setGmailSelected((prev) => {
          const next = new Set(prev);
          importedEmailIds.forEach((id) => next.delete(id));
          return next;
        });
        setPendingEmails((prev) => prev.filter((email) => !importedSet.has(email.messageId)));
        setPendingSelected((prev) => {
          const next = new Set(prev);
          importedEmailIds.forEach((id) => next.delete(id));
          return next;
        });
        requestGmailPendingRefresh();
      }
      setCreated(result.created);
      setResolvedCategories(result.resolvedCategories ?? []);
      if (result.resolvedCategories?.length) {
        setCategories((prev) => {
          const known = new Set(prev.map((c) => c.id));
          const added = result.resolvedCategories
            .filter((rc) => !known.has(rc.id))
            .map((rc) => ({
              id: rc.id,
              name: rc.name,
              color: rc.color,
              icon: null,
              movement_count: 0,
              created_at: new Date().toISOString(),
            }));
          return [...prev, ...added].sort((a, b) => a.name.localeCompare(b.name));
        });
      }
      setStep('confirm');
    } catch (err) {
      const conflictIds =
        axios.isAxiosError(err) && err.response?.status === 409
          ? (err.response.data?.details?.alreadyImported as string[] | undefined)
          : undefined;
      if (conflictIds && conflictIds.length > 0) {
        const conflictSet = new Set(conflictIds);
        setRows((prev) =>
          prev.map((r) =>
            r.gmailMessageId && conflictSet.has(r.gmailMessageId)
              ? { ...r, alreadyImported: true }
              : r
          )
        );
        setGmailMessages((prev) =>
          prev.map((m) => (conflictSet.has(m.id) ? { ...m, alreadyImported: true } : m))
        );
        setConfirmError(
          'Some emails were already imported. The marked rows were skipped — import the remaining rows.'
        );
      } else {
        setConfirmError('Failed to import movements. Please try again.');
      }
    } finally {
      setConfirming(false);
    }
  }

  function renderGmailEmailErrors() {
    if (gmailEmailErrors.length === 0) return null;
    return (
      <div className="mt-4 space-y-2">
        {gmailEmailErrors.map((email) => (
          <div
            key={email.messageId}
            className="flex items-center justify-between gap-3 rounded-lg border border-warning-200 dark:border-warning-800 bg-warning-50 dark:bg-warning-900/20 p-3 text-sm"
          >
            <span className="text-warning-800 dark:text-warning-300">
              {email.subject || email.messageId}: {email.error}
            </span>
            <button
              type="button"
              onClick={() => handleExtractEmails([email.messageId])}
              disabled={gmailExtracting}
              className="text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        ))}
      </div>
    );
  }

  function renderPendingSection() {
    const selectedPending = pendingSelected.size;
    const lastChecked = gmailLastPolledAt
      ? new Date(gmailLastPolledAt).toLocaleString()
      : 'Never';

    if (gmailNeedsReconnect) {
      return (
        <div
          role="alert"
          className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-warning-200 bg-warning-50 p-4 text-sm text-warning-800 dark:border-warning-900 dark:bg-warning-900/30 dark:text-warning-200"
        >
          <span>Reconnect Gmail to review pending imports.</span>
          <a
            href="/settings/gmail"
            className="rounded bg-warning-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-warning-700"
          >
            Reconnect
          </a>
        </div>
      );
    }

    return (
      <section className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-medium text-neutral-900 dark:text-white">Pending review</h2>
            <p className="mt-1 text-xs text-neutral-500">Last checked: {lastChecked}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handlePollNow}
              disabled={pollingNow}
              className="rounded border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              {pollingNow ? 'Checking...' : 'Check now'}
            </button>
            <button
              type="button"
              onClick={handleReviewPending}
              disabled={selectedPending === 0}
              className="rounded bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Review {selectedPending} email{selectedPending !== 1 ? 's' : ''}
            </button>
          </div>
        </div>

        {pendingError && <p className="mt-3 text-sm text-danger-600">{pendingError}</p>}
        {pendingLoading && <p className="mt-3 text-sm text-neutral-500">Loading pending imports...</p>}

        {pendingErrorEmails.length > 0 && (
          <div className="mt-4 space-y-2">
            {pendingErrorEmails.map((email) => (
              <div
                key={email.messageId}
                className="flex items-center justify-between gap-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm dark:border-warning-800 dark:bg-warning-900/20"
              >
                <div className="min-w-0">
                  <p className="font-medium text-warning-900 dark:text-warning-200">
                    {email.subject || email.messageId}
                  </p>
                  <p className="mt-1 text-warning-800 dark:text-warning-300">
                    {email.error || 'Extraction failed'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRetryPending(email.messageId)}
                  disabled={pendingRetrying === email.messageId}
                  className="text-primary-600 hover:text-primary-700 font-medium disabled:opacity-50"
                >
                  {pendingRetrying === email.messageId ? 'Retrying...' : 'Retry'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 grid gap-3">
          {pendingEmails.map((email) => {
            const checked = pendingSelected.has(email.messageId);
            return (
              <article
                key={email.messageId}
                data-testid="pending-email-card"
                className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800"
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={`Select pending email ${email.messageId}`}
                    checked={checked}
                    onChange={() => togglePendingSelected(email.messageId)}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="truncate font-medium text-neutral-900 dark:text-white">
                        {email.subject || email.messageId}
                      </p>
                      <button
                        type="button"
                        aria-label={`Dismiss ${email.messageId}`}
                        onClick={() => handleDismissPending(email.messageId)}
                        className="text-neutral-400 hover:text-danger-600 text-lg leading-none"
                      >
                        ×
                      </button>
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      {email.from || 'Unknown sender'} ·{' '}
                      {email.date ? new Date(email.date).toLocaleString() : 'Unknown date'}
                    </p>
                    <ul className="mt-3 space-y-1">
                      {email.movements.map((movement, index) => (
                        <li key={index} className="text-sm text-neutral-600 dark:text-neutral-300">
                          {(movement.store || movement.description || 'Movement')} — $
                          {Number(movement.amount).toFixed(2)} — {movement.date}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </article>
            );
          })}
          {!pendingLoading && pendingEmails.length === 0 && (
            <p className="rounded-lg border border-neutral-200 bg-white p-4 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800">
              No pending emails.
            </p>
          )}
        </div>
      </section>
    );
  }

  if (step === 'upload') {
    const selectedCount = gmailSelected.size;
    const gmailReady = gmailConnected === true && gmailSenders.length > 0;
    return (
      <main className="flex-1 overflow-y-auto p-6 max-w-5xl mx-auto w-full">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Import Movements</h1>

        <div role="tablist" aria-label="Import source" className="mt-5 inline-flex rounded-lg border border-neutral-200 dark:border-neutral-700 p-1 bg-white dark:bg-neutral-800">
          <button
            type="button"
            role="tab"
            aria-selected={sourceTab === 'upload'}
            onClick={() => setSourceTab('upload')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              sourceTab === 'upload'
                ? 'bg-primary-600 text-white'
                : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
            }`}
          >
            Upload receipt
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceTab === 'gmail'}
            onClick={() => setSourceTab('gmail')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              sourceTab === 'gmail'
                ? 'bg-primary-600 text-white'
                : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
            }`}
          >
            From Gmail
          </button>
        </div>

        {sourceTab === 'upload' ? (
          <section className="max-w-2xl">
            <p className="mt-4 text-neutral-500 dark:text-neutral-400">
              Upload a receipt or invoice image to extract expenses automatically.
            </p>

            <div
              data-testid="dropzone"
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onClick={() => !file && fileInputRef.current?.click()}
              className="mt-6 border-2 border-dashed border-neutral-300 dark:border-neutral-600 rounded-xl p-12 flex flex-col items-center justify-center gap-3 hover:border-primary-500 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
              style={{ cursor: file ? 'default' : 'pointer' }}
            >
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  {previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Preview"
                      data-testid="file-preview"
                      className="max-h-48 max-w-full rounded-lg object-contain"
                    />
                  ) : (
                    <div data-testid="pdf-icon" className="text-5xl">📄</div>
                  )}
                  <p className="text-sm text-neutral-600 dark:text-neutral-400 text-center">{file.name}</p>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFile(null);
                      setPreviewUrl(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="text-xs text-danger-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <>
                  <div className="text-4xl text-neutral-400">📤</div>
                  <p className="text-neutral-600 dark:text-neutral-400 text-sm text-center">
                    Drag and drop a JPEG, PNG, or PDF, or{' '}
                    <span className="text-primary-600 font-medium">browse</span>
                  </p>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className="hidden"
                onChange={handleFileChange}
                data-testid="file-input"
              />
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleProcess}
                disabled={!file}
                data-testid="process-button"
                className="px-5 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
              >
                Process Image
              </button>
            </div>
          </section>
        ) : (
          <section className="mt-6">
            {gmailSetupLoading && <p className="text-sm text-neutral-500">Loading Gmail settings...</p>}
            {gmailSetupError && <p className="text-sm text-danger-600">{gmailSetupError}</p>}
            {!gmailSetupLoading && gmailConnected === false && (
              <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-5 max-w-xl">
                <h2 className="text-lg font-medium text-neutral-900 dark:text-white">Connect Gmail</h2>
                <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  Import movements from your bank notification emails.
                </p>
                <a
                  href="/settings/gmail"
                  className="mt-4 inline-flex px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium"
                >
                  Connect Gmail
                </a>
              </div>
            )}
            {!gmailSetupLoading && gmailConnected === true && gmailSenders.length === 0 && (
              <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-5 max-w-xl">
                <h2 className="text-lg font-medium text-neutral-900 dark:text-white">
                  Add the addresses your bank sends purchase alerts from
                </h2>
                <a
                  href="/settings/gmail"
                  className="mt-4 inline-flex px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium"
                >
                  Configure senders
                </a>
              </div>
            )}
            {gmailReady && (
              <>
                {renderPendingSection()}
                <div className="grid gap-3 md:grid-cols-[160px_160px_180px_1fr] items-end">
                  <label className="text-sm text-neutral-600 dark:text-neutral-400">
                    Range
                    <select
                      value={gmailPreset}
                      onChange={(e) => handlePresetChange(e.target.value as GmailPreset)}
                      className="mt-1 w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
                    >
                      <option value="this-week">This week</option>
                      <option value="this-month">This month</option>
                      <option value="last-week">Last week</option>
                      <option value="last-month">Last month</option>
                      <option value="last-30-days">Last 30 days</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {gmailPreset === 'custom' && (
                    <>
                      <label className="text-sm text-neutral-600 dark:text-neutral-400">
                        From
                        <input
                          type="date"
                          value={gmailFrom}
                          onChange={(e) => setGmailFrom(e.target.value)}
                          className="mt-1 w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
                        />
                      </label>
                      <label className="text-sm text-neutral-600 dark:text-neutral-400">
                        To
                        <input
                          type="date"
                          value={gmailTo}
                          onChange={(e) => setGmailTo(e.target.value)}
                          className="mt-1 w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
                        />
                      </label>
                    </>
                  )}
                  <label className="text-sm text-neutral-600 dark:text-neutral-400">
                    Sender
                    <select
                      aria-label="Sender"
                      value={gmailSender}
                      onChange={(e) => setGmailSender(e.target.value)}
                      className="mt-1 w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
                    >
                      <option value="">All senders</option>
                      {gmailSenders.map((sender) => (
                        <option key={sender.id} value={sender.email}>
                          {sender.label || sender.email}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-neutral-600 dark:text-neutral-400">
                    Subject
                    <input
                      type="search"
                      aria-label="Subject"
                      value={gmailSubjectInput}
                      onChange={(e) => setGmailSubjectInput(e.target.value)}
                      placeholder="Search subject"
                      className="mt-1 w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-2 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
                    />
                  </label>
                </div>

                {renderGmailEmailErrors()}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-neutral-500">{selectedCount} / 25 selected</span>
                    <button
                      type="button"
                      onClick={selectVisibleGmailMessages}
                      disabled={
                        gmailMessagesLoading ||
                        selectedCount >= 25 ||
                        !gmailMessages.some((message) => !message.alreadyImported && !gmailSelected.has(message.id))
                      }
                      className="rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      Select visible
                    </button>
                    <button
                      type="button"
                      onClick={clearGmailSelection}
                      disabled={selectedCount === 0}
                      className="rounded border border-neutral-200 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    >
                      Clear
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleExtractEmails()}
                    disabled={selectedCount === 0 || gmailExtracting}
                    className="px-4 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium"
                  >
                    {gmailExtracting ? 'Extracting...' : `Extract ${selectedCount} email${selectedCount !== 1 ? 's' : ''}`}
                  </button>
                </div>

                {gmailMessagesError && <p className="mt-4 text-sm text-danger-600">{gmailMessagesError}</p>}
                <div className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800">
                  {gmailMessages.map((message) => {
                    const checked = gmailSelected.has(message.id);
                    const disabled = message.alreadyImported || (!checked && selectedCount >= 25);
                    return (
                      <label key={message.id} className="flex gap-3 p-4">
                        <input
                          type="checkbox"
                          aria-label={`Select email ${message.id}`}
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleGmailSelected(message.id)}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-neutral-900 dark:text-white truncate">{message.subject}</p>
                            {message.alreadyImported && (
                              <span className="rounded-full bg-neutral-100 dark:bg-neutral-700 px-2 py-0.5 text-xs text-neutral-500">
                                Imported
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-neutral-500">{message.from} · {new Date(message.date).toLocaleString()}</p>
                          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{message.snippet}</p>
                        </div>
                      </label>
                    );
                  })}
                  {!gmailMessagesLoading && gmailMessages.length === 0 && (
                    <p className="p-6 text-center text-sm text-neutral-500">No emails found for these filters.</p>
                  )}
                </div>
                {gmailMessagesLoading && <p className="mt-3 text-sm text-neutral-500">Loading emails...</p>}
                {gmailNextPageToken && (
                  <button
                    type="button"
                    onClick={() => loadGmailMessages(true, gmailNextPageToken)}
                    disabled={gmailMessagesLoading}
                    className="mt-4 px-4 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </section>
        )}
      </main>
    );
  }

  if (step === 'processing') {
    return (
      <main className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Processing...</h1>
        <div data-testid="processing-indicator" className="mt-8 flex flex-col gap-4">
          <ProcessingStageItem
            label="Extracting text..."
            active={processingStage === 'extracting'}
            done={processingStage === 'analyzing'}
          />
          <ProcessingStageItem label="Analyzing with AI..." active={processingStage === 'analyzing'} done={false} />
        </div>
      </main>
    );
  }

  if (step === 'review') {
    const validRows = rows.filter((r) => r.amount.trim() !== '' && !r.alreadyImported);
    const showSource = rows.some((r) => r.gmailMessageId !== null);
    return (
      <main className="flex-1 overflow-y-auto p-6">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Review Extracted Movements</h1>

        {extractError && (
          <div
            data-testid="extract-error"
            className="mt-4 p-4 bg-warning-50 dark:bg-warning-900/20 border border-warning-200 dark:border-warning-800 rounded-lg"
          >
            <p className="text-warning-800 dark:text-warning-300 text-sm">
              <strong>Note:</strong> {extractError}. You can fill in the movements manually below.
            </p>
          </div>
        )}

        {reviewSource === 'gmail' && renderGmailEmailErrors()}

        {rawText && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 select-none">
              Raw extracted text
            </summary>
            <pre
              data-testid="raw-text"
              className="mt-2 p-3 bg-neutral-100 dark:bg-neutral-800 rounded text-xs text-neutral-700 dark:text-neutral-300 whitespace-pre-wrap overflow-auto max-h-40"
            >
              {rawText}
            </pre>
          </details>
        )}

        <div className="mt-6 flex gap-6">
          <div className="flex-1 overflow-x-auto">
            <table className="w-full text-sm" data-testid="movements-table">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-700">
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Amount</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Date</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Time</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">
                    Description
                  </th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Store</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Category</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Paid with</th>
                  {showSource && (
                    <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Source</th>
                  )}
                  <th className="py-2 px-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ReviewRowComponent
                    key={row._key}
                    row={row}
                    categories={categories}
                    paymentMethods={paymentMethods}
                    showSource={showSource}
                    onAmountChange={(val) => updateRow(row._key, { amount: val, amountSuspect: false })}
                    onDateChange={(val) => updateRow(row._key, { date: val })}
                    onTimeChange={(val) => updateRow(row._key, { time: val })}
                    onDescriptionChange={(val) => handleRowDescriptionChange(row._key, val)}
                    onStoreChange={(val) => handleRowStoreChange(row._key, val)}
                    onCategoryChange={(id, name, color) =>
                      updateRow(row._key, { categoryId: id, categoryName: name, color, aiSuggested: false })
                    }
                    onUseNewCategory={() =>
                      updateRow(row._key, {
                        categoryId: null,
                        categoryName: null,
                        color: null,
                        newCategoryName: '',
                        aiSuggested: false,
                      })
                    }
                    onNewCategoryNameChange={(val) => handleRowNewCategoryNameChange(row._key, val)}
                    onRevertToSelect={() =>
                      updateRow(row._key, { newCategoryName: null, aiSuggested: false })
                    }
                    onPaymentMethodChange={(id) =>
                      updateRow(row._key, { paymentMethodId: id, paymentAiSuggested: false })
                    }
                    onRegisterCard={() => handleRegisterCard(row._key)}
                    onRemove={() => removeRow(row._key)}
                  />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && reviewSource === 'gmail' && (
              <div className="mt-6 text-center">
                <p className="text-neutral-500 text-sm">No movements found in the selected emails.</p>
                <button
                  type="button"
                  onClick={() => setStep('upload')}
                  className="mt-3 px-4 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Back to email list
                </button>
              </div>
            )}
            {rows.length === 0 && reviewSource === 'upload' && (
              <p className="mt-4 text-center text-neutral-500 text-sm">
                No movements extracted. Add rows manually below.
              </p>
            )}
            <button
              type="button"
              onClick={addRow}
              data-testid="add-row-button"
              className="mt-3 text-sm text-primary-600 hover:text-primary-700 font-medium transition-colors"
            >
              + Add row
            </button>
          </div>

          {previewUrl && (
            <div className="w-72 shrink-0">
              <img
                src={previewUrl}
                alt="Uploaded receipt"
                className="w-full rounded-lg object-contain border border-neutral-200 dark:border-neutral-700"
              />
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center gap-4">
          {confirmError && <p className="text-sm text-danger-600">{confirmError}</p>}
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming || validRows.length === 0}
            data-testid="import-button"
            className="ml-auto px-5 py-2 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
          >
            {confirming ? 'Importing...' : `Import ${validRows.length} Movement${validRows.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Import Complete</h1>
      <div data-testid="success-summary" className="mt-6">
        <p className="text-neutral-600 dark:text-neutral-400 mb-4">
          Successfully imported {created?.length ?? 0} movement{(created?.length ?? 0) !== 1 ? 's' : ''}.
        </p>
        {importedEmailCount > 0 && (
          <p data-testid="imported-emails-summary" className="text-neutral-600 dark:text-neutral-400 mb-4 -mt-2">
            {importedEmailCount} email{importedEmailCount !== 1 ? 's' : ''} marked as imported.
          </p>
        )}
        {resolvedCategories.some((c) => c.created) && (
          <div
            data-testid="new-categories-summary"
            className="mb-4 p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700"
          >
            <p className="text-sm text-neutral-600 dark:text-neutral-400">New categories created:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {resolvedCategories
                .filter((c) => c.created)
                .map((c) => (
                  <span
                    key={c.id}
                    className="inline-flex items-center gap-1.5 text-xs text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 rounded-full px-2 py-0.5"
                  >
                    <span
                      data-testid="new-category-swatch"
                      className="w-3 h-3 rounded-full inline-block"
                      style={{ backgroundColor: c.color ?? '#9ca3af' }}
                    />
                    {c.name}
                  </span>
                ))}
            </div>
          </div>
        )}
        <ul className="space-y-2">
          {created?.map((m) => {
            const pm = m.payment_method_id != null
              ? paymentMethods.find((p) => p.id === m.payment_method_id)
              : undefined;
            return (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm text-neutral-700 dark:text-neutral-300 truncate">
                    {m.description || m.date}
                  </span>
                  <span className="text-xs text-neutral-500 whitespace-nowrap">{m.date}</span>
                  {m.store && (
                    <span className="text-xs text-neutral-500 truncate">{m.store}</span>
                  )}
                  {pm && (
                    <span
                      data-testid="summary-payment-method"
                      className="inline-flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 rounded-full px-2 py-0.5 whitespace-nowrap"
                    >
                      {paymentMethodIcon(pm.kind)} {pm.name}
                    </span>
                  )}
                </div>
                <span className="font-medium text-neutral-900 dark:text-white whitespace-nowrap">
                  ${Number(m.amount).toFixed(2)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-6 flex items-center gap-6">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 text-sm font-medium"
          >
            ← View on Dashboard
          </a>
          {importedEmailCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setRows([]);
                setCreated(null);
                setResolvedCategories([]);
                setConfirmError(null);
                setImportedEmailCount(0);
                setStep('upload');
              }}
              className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 text-sm font-medium"
            >
              ← Back to Gmail emails
            </button>
          )}
        </div>
      </div>
    </main>
  );
}
