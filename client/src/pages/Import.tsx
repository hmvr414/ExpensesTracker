import { useState, useRef, useEffect } from 'react';
import { Category, getCategories } from '../api/categories';
import { extractFromImage, confirmImport, ExtractedMovement, ConfirmResponse } from '../api/import';
import { suggestCategory } from '../api/suggest';

type Step = 'upload' | 'processing' | 'review' | 'confirm';

interface ReviewRow {
  _key: string;
  amount: string;
  date: string;
  description: string;
  store: string;
  categoryId: number | null;
  categoryName: string | null;
  color: string | null;
  aiSuggested: boolean;
  suggestLoading: boolean;
}

let keyCounter = 0;
function makeKey() {
  return String(++keyCounter);
}

function movementToRow(m: ExtractedMovement): ReviewRow {
  return {
    _key: makeKey(),
    amount: String(m.amount),
    date: m.date,
    description: m.description ?? '',
    store: m.store ?? '',
    categoryId: m.categoryId,
    categoryName: m.categoryName ?? null,
    color: m.color ?? null,
    aiSuggested: m.aiSuggested,
    suggestLoading: false,
  };
}

function emptyRow(): ReviewRow {
  return {
    _key: makeKey(),
    amount: '',
    date: new Date().toISOString().split('T')[0],
    description: '',
    store: '',
    categoryId: null,
    categoryName: null,
    color: null,
    aiSuggested: false,
    suggestLoading: false,
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
  onAmountChange: (val: string) => void;
  onDateChange: (val: string) => void;
  onDescriptionChange: (val: string) => void;
  onStoreChange: (val: string) => void;
  onCategoryChange: (id: number | null, name: string | null, color: string | null) => void;
  onRemove: () => void;
}

function ReviewRowComponent({
  row,
  categories,
  onAmountChange,
  onDateChange,
  onDescriptionChange,
  onStoreChange,
  onCategoryChange,
  onRemove,
}: ReviewRowProps) {
  return (
    <tr className="border-b border-neutral-100 dark:border-neutral-800">
      <td className="py-1 px-2">
        <input
          type="number"
          value={row.amount}
          onChange={(e) => onAmountChange(e.target.value)}
          placeholder="0.00"
          aria-label="Amount"
          className="w-24 border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white"
        />
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
          type="text"
          value={row.description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Description"
          aria-label="Description"
          className="w-full border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white min-w-32"
        />
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
      </td>
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
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [processingStage, setProcessingStage] = useState<'extracting' | 'analyzing'>('extracting');
  const [rawText, setRawText] = useState('');
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [attachmentId, setAttachmentId] = useState<number | undefined>();
  const [categories, setCategories] = useState<Category[]>([]);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [created, setCreated] = useState<ConfirmResponse['created'] | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const suggestTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const stageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    getCategories().then(setCategories).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      suggestTimers.current.forEach((t) => clearTimeout(t));
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
    };
  }, []);

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
        setRows(result.movements.map(movementToRow));
      }
      setStep('review');
    } catch {
      if (stageTimerRef.current) clearTimeout(stageTimerRef.current);
      setExtractError('Failed to process image. Please try again.');
      setRows([]);
      setStep('review');
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
        if (result.categoryId != null) {
          updateRow(key, {
            categoryId: result.categoryId,
            categoryName: result.categoryName ?? null,
            color: result.color ?? null,
            aiSuggested: true,
            suggestLoading: false,
          });
        } else {
          updateRow(key, { suggestLoading: false });
        }
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
      const movements = rows
        .filter((r) => r.amount.trim() !== '')
        .map((r) => ({
          amount: Number(r.amount),
          date: r.date,
          description: r.description || undefined,
          store: r.store || undefined,
          category_id: r.categoryId ?? null,
        }));

      const result = await confirmImport({ attachmentId, movements });
      setCreated(result.created);
      setStep('confirm');
    } catch {
      setConfirmError('Failed to import movements. Please try again.');
    } finally {
      setConfirming(false);
    }
  }

  if (step === 'upload') {
    return (
      <main className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white">Import from Image</h1>
        <p className="mt-2 text-neutral-500 dark:text-neutral-400">
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
    const validRows = rows.filter((r) => r.amount.trim() !== '');
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
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">
                    Description
                  </th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Store</th>
                  <th className="py-2 px-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Category</th>
                  <th className="py-2 px-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <ReviewRowComponent
                    key={row._key}
                    row={row}
                    categories={categories}
                    onAmountChange={(val) => updateRow(row._key, { amount: val })}
                    onDateChange={(val) => updateRow(row._key, { date: val })}
                    onDescriptionChange={(val) => handleRowDescriptionChange(row._key, val)}
                    onStoreChange={(val) => handleRowStoreChange(row._key, val)}
                    onCategoryChange={(id, name, color) =>
                      updateRow(row._key, { categoryId: id, categoryName: name, color, aiSuggested: false })
                    }
                    onRemove={() => removeRow(row._key)}
                  />
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
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
        <ul className="space-y-2">
          {created?.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700"
            >
              <span className="text-sm text-neutral-700 dark:text-neutral-300">{m.description || m.date}</span>
              <span className="font-medium text-neutral-900 dark:text-white">
                ${Number(m.amount).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
        <a
          href="/"
          className="mt-6 inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 text-sm font-medium"
        >
          ← View on Dashboard
        </a>
      </div>
    </main>
  );
}
