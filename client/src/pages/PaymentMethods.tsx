import { useState, useEffect, useRef } from 'react';
import {
  PaymentMethod,
  PaymentMethodKind,
  PaymentMethodBrand,
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  getPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
} from '../api/paymentMethods';

const KIND_OPTIONS: { value: PaymentMethodKind; label: string }[] = [
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'other', label: 'Other' },
];

const BRAND_OPTIONS: { value: PaymentMethodBrand; label: string }[] = [
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'amex', label: 'Amex' },
  { value: 'other', label: 'Other' },
];

function kindIcon(kind: PaymentMethodKind): string {
  switch (kind) {
    case 'cash':
      return '💵';
    case 'card':
      return '💳';
    case 'bank_transfer':
      return '🏦';
    default:
      return '💼';
  }
}

function brandLabel(brand: PaymentMethodBrand): string {
  return BRAND_OPTIONS.find((b) => b.value === brand)?.label ?? brand;
}

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse bg-neutral-200 dark:bg-neutral-700 rounded ${className}`}
    />
  );
}

function DeletePopover({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="absolute right-0 top-8 z-10 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg p-3 w-48">
      <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-3">Confirm delete?</p>
      <div className="flex gap-2">
        <button
          onClick={onConfirm}
          className="flex-1 text-xs bg-danger-600 hover:bg-danger-700 text-white rounded px-2 py-1"
        >
          Confirm
        </button>
        <button
          onClick={onCancel}
          className="flex-1 text-xs bg-neutral-200 dark:bg-neutral-700 hover:bg-neutral-300 dark:hover:bg-neutral-600 text-neutral-700 dark:text-neutral-300 rounded px-2 py-1"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PaymentMethodRow({
  method,
  onUpdated,
  onDeleted,
}: {
  method: PaymentMethod;
  onUpdated: (updated: PaymentMethod) => void;
  onDeleted: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(method.name);
  const [editBrand, setEditBrand] = useState(method.brand ?? '');
  const [editVariant, setEditVariant] = useState(method.variant ?? '');
  const [editLast4, setEditLast4] = useState(method.last4 ?? '');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) nameInputRef.current?.focus();
  }, [editing]);

  async function saveEdit() {
    if (!editName.trim() || saving) return;
    setSaving(true);
    try {
      const input: UpdatePaymentMethodInput = { name: editName.trim() };
      if (method.kind === 'card') {
        if (editBrand) input.brand = editBrand as PaymentMethodBrand;
        if (editVariant.trim()) input.variant = editVariant.trim();
        if (/^\d{4}$/.test(editLast4.trim())) input.last4 = editLast4.trim();
      }
      const updated = await updatePaymentMethod(method.id, input);
      onUpdated({ ...updated, movement_count: method.movement_count });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deletePaymentMethod(method.id);
      onDeleted(method.id);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  function handleEditBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) saveEdit();
  }

  const canDelete = method.movement_count === 0;

  return (
    <li className="flex items-center gap-3 p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-100 dark:border-neutral-700">
      <span className="text-xl flex-shrink-0" data-testid="kind-icon">
        {kindIcon(method.kind)}
      </span>

      {editing ? (
        <div className="flex flex-col gap-2 flex-1" onBlur={handleEditBlur}>
          <input
            ref={nameInputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
            aria-label="Edit name"
            className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white w-full"
            disabled={saving}
          />
          {method.kind === 'card' && (
            <div className="flex gap-2">
              <select
                value={editBrand}
                onChange={(e) => setEditBrand(e.target.value)}
                aria-label="Edit brand"
                className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
                disabled={saving}
              >
                <option value="">No brand</option>
                {BRAND_OPTIONS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                value={editVariant}
                onChange={(e) => setEditVariant(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                aria-label="Edit variant"
                placeholder="Variant"
                className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white w-28"
                disabled={saving}
              />
              <input
                value={editLast4}
                onChange={(e) => setEditLast4(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
                aria-label="Edit last4"
                placeholder="Last 4"
                maxLength={4}
                className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white w-20"
                disabled={saving}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-neutral-900 dark:text-white">
            {method.name}
          </span>
          {method.kind === 'card' && method.brand && (
            <span className="text-xs bg-primary-50 dark:bg-primary-900/40 text-primary-700 dark:text-primary-300 rounded-full px-2 py-0.5 font-medium">
              {brandLabel(method.brand)}
            </span>
          )}
          {method.variant && (
            <span className="text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 rounded-full px-2 py-0.5 font-medium">
              {method.variant}
            </span>
          )}
          {method.last4 && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono">
              •••• {method.last4}
            </span>
          )}
        </div>
      )}

      <span className="text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 rounded-full px-2 py-0.5 font-medium">
        {method.movement_count}
      </span>

      <div className="flex items-center gap-1 relative flex-shrink-0">
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            aria-label="Edit"
            className="text-neutral-400 hover:text-primary-600 dark:hover:text-primary-400 p-1 rounded"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => canDelete && setShowDeleteConfirm(true)}
            aria-label="Delete"
            disabled={!canDelete || deleting}
            title={!canDelete ? `Cannot delete: ${method.movement_count} movement(s) linked` : undefined}
            className={`p-1 rounded ${
              canDelete
                ? 'text-neutral-400 hover:text-danger-600 dark:hover:text-danger-400'
                : 'text-neutral-300 dark:text-neutral-600 cursor-not-allowed'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {showDeleteConfirm && (
            <DeletePopover
              onConfirm={handleDelete}
              onCancel={() => setShowDeleteConfirm(false)}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function AddPaymentMethodForm({
  onCreated,
  autoFocus,
}: {
  onCreated: (method: PaymentMethod) => void;
  autoFocus: boolean;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<PaymentMethodKind>('card');
  const [brand, setBrand] = useState('');
  const [variant, setVariant] = useState('');
  const [last4, setLast4] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) nameInputRef.current?.focus();
  }, [autoFocus]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const input: CreatePaymentMethodInput = { name: name.trim(), kind };
      if (kind === 'card') {
        if (brand) input.brand = brand as PaymentMethodBrand;
        if (variant.trim()) input.variant = variant.trim();
        if (last4.trim()) input.last4 = last4.trim();
      }
      const created = await createPaymentMethod(input);
      onCreated({ ...created, movement_count: created.movement_count ?? 0 });
      setName('');
      setKind('card');
      setBrand('');
      setVariant('');
      setLast4('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 mb-4">
      <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200 mb-3">Add Payment Method</h2>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            ref={nameInputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Payment method name"
            className="flex-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
            disabled={submitting}
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PaymentMethodKind)}
            aria-label="Kind"
            className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
            disabled={submitting}
          >
            {KIND_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {kind === 'card' && (
          <div className="flex gap-2 flex-wrap">
            <select
              value={brand}
              onChange={(e) => setBrand(e.target.value)}
              aria-label="Brand"
              className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              disabled={submitting}
            >
              <option value="">Select brand</option>
              {BRAND_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="Variant (e.g. Platinum)"
              className="w-44 text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              disabled={submitting}
            />
            <input
              value={last4}
              onChange={(e) => setLast4(e.target.value)}
              placeholder="Last 4 digits"
              maxLength={4}
              className="w-32 text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
              disabled={submitting}
            />
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="self-start bg-primary-600 hover:bg-primary-700 disabled:bg-neutral-300 dark:disabled:bg-neutral-600 text-white text-sm font-medium rounded px-4 py-2 transition-colors"
        >
          {submitting ? 'Adding…' : 'Add Payment Method'}
        </button>
      </div>
    </form>
  );
}

export function PaymentMethods() {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getPaymentMethods()
      .then(setMethods)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function handleCreated(method: PaymentMethod) {
    setMethods((prev) => [...prev, method].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function handleUpdated(updated: PaymentMethod) {
    setMethods((prev) =>
      prev
        .map((m) => (m.id === updated.id ? updated : m))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  function handleDeleted(id: number) {
    setMethods((prev) => prev.filter((m) => m.id !== id));
  }

  const onlyCashExists =
    !loading &&
    (methods.length === 0 || (methods.length === 1 && methods[0].kind === 'cash'));

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white mb-6">
        Payment Methods
      </h1>

      {onlyCashExists && (
        <div className="bg-primary-50 dark:bg-primary-900/30 border border-primary-200 dark:border-primary-800 rounded-lg p-4 mb-4 flex items-center gap-3">
          <span className="text-2xl">💳</span>
          <div>
            <p className="text-sm font-medium text-primary-900 dark:text-primary-100">
              Register your first card to track how you pay
            </p>
            <p className="text-xs text-primary-700 dark:text-primary-300 mt-0.5">
              Add the cards and accounts you use so imports can match them automatically.
            </p>
          </div>
        </div>
      )}

      <AddPaymentMethodForm onCreated={handleCreated} autoFocus={onlyCashExists} />

      {loading ? (
        <div data-testid="payment-methods-skeleton" className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {methods.map((method) => (
            <PaymentMethodRow
              key={method.id}
              method={method}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
