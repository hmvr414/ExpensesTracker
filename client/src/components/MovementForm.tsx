import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getCategories, Category } from '../api/categories';
import { createMovement, updateMovement, Movement } from '../api/movements';
import { createAttachment, deleteAttachment } from '../api/attachments';
import { suggestCategory } from '../api/suggest';
import { getPaymentMethods, PaymentMethod } from '../api/paymentMethods';
import { paymentMethodIcon } from '../helpers/paymentMethod';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  movement?: Movement;
}

interface ExistingAttachment {
  id: number;
  file_name: string;
  url: string;
}

export function MovementForm({ open, onClose, onSaved, movement }: Props) {
  const today = new Date().toISOString().split('T')[0];

  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [description, setDescription] = useState('');
  const [store, setStore] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [aiSuggested, setAiSuggested] = useState(false);
  const [suggestedNewCategory, setSuggestedNewCategory] = useState<string | null>(null);
  const [newCategoryMode, setNewCategoryMode] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [paymentMethodId, setPaymentMethodId] = useState<number | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [existingAttachments, setExistingAttachments] = useState<ExistingAttachment[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors newCategoryMode so the async suggest callback can read the
  // current value instead of the one captured when the timer was scheduled
  const newCategoryModeRef = useRef(false);

  useEffect(() => {
    newCategoryModeRef.current = newCategoryMode;
  }, [newCategoryMode]);

  useEffect(() => {
    if (!open) return;
    getCategories().then(setCategories).catch(() => {});
    getPaymentMethods().then(setPaymentMethods).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (movement) {
      setAmount(movement.amount);
      setDate(movement.date);
      setDescription(movement.description ?? '');
      setStore(movement.store ?? '');
      setCategoryId(movement.category_id);
      setPaymentMethodId(movement.payment_method_id);
      setExistingAttachments(
        movement.attachments.map((a) => ({ id: a.id, file_name: a.file_name, url: a.url }))
      );
    } else {
      setAmount('');
      setDate(today);
      setDescription('');
      setStore('');
      setCategoryId(null);
      setPaymentMethodId(null);
      setExistingAttachments([]);
      setFiles([]);
    }
    setAiSuggested(false);
    setSuggestedNewCategory(null);
    setNewCategoryMode(false);
    setNewCategoryName('');
    setErrors({});
    setToast(null);
  }, [open, movement, today]);

  useEffect(() => {
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  function scheduleSuggest(storeVal: string, descVal: string) {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    if (!storeVal.trim() && !descVal.trim()) return;
    suggestTimerRef.current = setTimeout(async () => {
      setSuggestLoading(true);
      try {
        const result = await suggestCategory({
          store: storeVal.trim() || undefined,
          description: descVal.trim() || undefined,
        });
        // A response landing after the user switched to the new-category
        // text input must not change the category state behind it
        if (newCategoryModeRef.current) return;
        if (result.categoryId != null) {
          setCategoryId(result.categoryId);
          setAiSuggested(true);
          setSuggestedNewCategory(null);
        } else {
          setSuggestedNewCategory(result.suggestedNewCategory ?? null);
        }
      } catch {
        // ignore
      } finally {
        setSuggestLoading(false);
      }
    }, 400);
  }

  function handleStoreChange(val: string) {
    setStore(val);
    scheduleSuggest(val, description);
  }

  function handleDescriptionChange(val: string) {
    setDescription(val);
    scheduleSuggest(store, val);
  }

  function handleCategoryChange(val: string) {
    setCategoryId(val ? Number(val) : null);
    setAiSuggested(false);
  }

  function acceptNewCategory() {
    if (!suggestedNewCategory) return;
    setNewCategoryName(suggestedNewCategory);
    setNewCategoryMode(true);
    setAiSuggested(true);
    setSuggestedNewCategory(null);
  }

  function revertToCategorySelect() {
    setNewCategoryMode(false);
    setNewCategoryName('');
    setAiSuggested(false);
  }

  function handleNewCategoryNameChange(val: string) {
    if (val === '') {
      revertToCategorySelect();
      return;
    }
    setNewCategoryName(val);
    setAiSuggested(false);
  }

  function validate(): Record<string, string> {
    const errs: Record<string, string> = {};
    const amountNum = parseFloat(amount);
    if (!amount || isNaN(amountNum) || amountNum <= 0) {
      errs.amount = 'Amount must be a positive number';
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errs.date = 'Date must be a valid date (YYYY-MM-DD)';
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      const categoryPayload =
        newCategoryMode && newCategoryName.trim()
          ? { new_category_name: newCategoryName.trim() }
          : { category_id: categoryId };
      let savedId: number;
      if (movement) {
        const updated = await updateMovement(movement.id, {
          amount: parseFloat(amount),
          date,
          description: description || undefined,
          store: store || undefined,
          ...categoryPayload,
          payment_method_id: paymentMethodId,
        });
        savedId = updated.id;
      } else {
        const created = await createMovement({
          amount: parseFloat(amount),
          date,
          description: description || undefined,
          store: store || undefined,
          ...categoryPayload,
          payment_method_id: paymentMethodId,
        });
        savedId = created.id;
      }

      for (const file of files) {
        await createAttachment(file, savedId);
      }

      setToast({ type: 'success', message: movement ? 'Expense updated!' : 'Expense added!' });
      closeTimerRef.current = setTimeout(() => {
        onSaved();
        onClose();
      }, 1200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setToast({ type: 'error', message });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteAttachment(id: number) {
    try {
      await deleteAttachment(id);
      setExistingAttachments((prev) => prev.filter((a) => a.id !== id));
    } catch {
      // ignore
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={movement ? 'Edit Expense' : 'Add Expense'}
      className="fixed inset-0 z-50 flex justify-end"
    >
      <div
        data-testid="form-overlay"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-md bg-white dark:bg-neutral-800 shadow-xl flex flex-col h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-100 dark:border-neutral-700">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
            {movement ? 'Edit Expense' : 'Add Expense'}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-1 rounded-md text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {/* Amount */}
            <div>
              <label
                htmlFor="amount"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Amount{' '}
                <span aria-hidden="true" className="text-danger-600">
                  *
                </span>
              </label>
              <input
                id="amount"
                type="number"
                step="0.01"
                min="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                  errors.amount ? 'border-danger-500' : 'border-neutral-300 dark:border-neutral-600'
                } bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white`}
              />
              {errors.amount && (
                <p className="mt-1 text-xs text-danger-600">{errors.amount}</p>
              )}
            </div>

            {/* Date */}
            <div>
              <label
                htmlFor="date"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Date{' '}
                <span aria-hidden="true" className="text-danger-600">
                  *
                </span>
              </label>
              <input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 ${
                  errors.date ? 'border-danger-500' : 'border-neutral-300 dark:border-neutral-600'
                } bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white`}
              />
              {errors.date && (
                <p className="mt-1 text-xs text-danger-600">{errors.date}</p>
              )}
            </div>

            {/* Store */}
            <div>
              <label
                htmlFor="store"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Store
              </label>
              <input
                id="store"
                type="text"
                value={store}
                onChange={(e) => handleStoreChange(e.target.value)}
                placeholder="e.g. Walmart"
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              />
            </div>

            {/* Description */}
            <div>
              <label
                htmlFor="description"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Description
              </label>
              <input
                id="description"
                type="text"
                value={description}
                onChange={(e) => handleDescriptionChange(e.target.value)}
                placeholder="e.g. Weekly groceries"
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              />
            </div>

            {/* Category */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label
                  htmlFor="category"
                  className="block text-sm font-medium text-neutral-700 dark:text-neutral-300"
                >
                  Category
                </label>
                {aiSuggested && (
                  <span className="text-xs text-primary-600 font-medium">✦ AI suggested</span>
                )}
                {suggestLoading && (
                  <span
                    data-testid="suggest-spinner"
                    className="text-xs text-neutral-400 animate-spin inline-block"
                  >
                    ⟳
                  </span>
                )}
              </div>
              {newCategoryMode ? (
                <div className="flex items-center gap-2">
                  <input
                    id="category"
                    type="text"
                    value={newCategoryName}
                    onChange={(e) => handleNewCategoryNameChange(e.target.value)}
                    maxLength={40}
                    placeholder="New category name"
                    data-testid="new-category-input"
                    className="w-full rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
                  />
                  <button
                    type="button"
                    onClick={revertToCategorySelect}
                    aria-label="Choose existing category"
                    title="Choose an existing category instead"
                    data-testid="new-category-toggle"
                    className="p-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
                  >
                    ⌄
                  </button>
                </div>
              ) : (
                <>
                  <select
                    id="category"
                    value={categoryId ?? ''}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                    className="w-full rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
                  >
                    <option value="">No category</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                  {suggestedNewCategory && categoryId == null && (
                    <button
                      type="button"
                      onClick={acceptNewCategory}
                      data-testid="create-category-hint"
                      className="mt-1 text-xs text-primary-600 hover:underline"
                    >
                      Create category "{suggestedNewCategory}"?
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Paid with */}
            <div>
              <label
                htmlFor="payment-method"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Paid with
              </label>
              <select
                id="payment-method"
                value={paymentMethodId ?? ''}
                onChange={(e) => setPaymentMethodId(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-lg border border-neutral-300 dark:border-neutral-600 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              >
                <option value="">Not specified</option>
                {paymentMethods.map((pm) => (
                  <option key={pm.id} value={pm.id}>
                    {paymentMethodIcon(pm.kind)} {pm.name}
                  </option>
                ))}
              </select>
              <Link
                to="/payment-methods"
                className="mt-1 inline-block text-xs text-primary-600 hover:underline"
              >
                Manage payment methods
              </Link>
            </div>

            {/* Attachments */}
            <div>
              <label
                htmlFor="file-input"
                className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
              >
                Attachments
              </label>

              {existingAttachments.length > 0 && (
                <ul className="mb-2 space-y-1">
                  {existingAttachments.map((att) => (
                    <li
                      key={att.id}
                      className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300"
                    >
                      <span className="flex-1 truncate">{att.file_name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${att.file_name}`}
                        onClick={() => handleDeleteAttachment(att.id)}
                        className="text-danger-500 hover:text-danger-700 text-xs"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <input
                id="file-input"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                className="w-full text-sm text-neutral-600 dark:text-neutral-400 file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
              />

              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li key={i} className="text-xs text-neutral-500">
                      {f.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {toast && (
            <div
              role="status"
              className={`mx-6 mb-4 px-4 py-2 rounded-lg text-sm font-medium ${
                toast.type === 'success'
                  ? 'bg-success-100 text-success-700 dark:bg-success-900/30 dark:text-success-300'
                  : 'bg-danger-100 text-danger-700 dark:bg-danger-900/30 dark:text-danger-300'
              }`}
            >
              {toast.message}
            </div>
          )}

          <div className="px-6 py-4 border-t border-neutral-100 dark:border-neutral-700 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2 bg-primary-600 text-white rounded-lg text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? 'Saving…' : movement ? 'Save Changes' : 'Add Expense'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
