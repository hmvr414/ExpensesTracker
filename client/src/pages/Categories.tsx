import { useState, useEffect, useRef } from 'react';
import {
  Category,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from '../api/categories';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  '#6b7280', '#1e293b',
];

function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      className={`animate-pulse bg-neutral-200 dark:bg-neutral-700 rounded ${className}`}
    />
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={`w-6 h-6 rounded-full border-2 transition-transform ${
            value === c ? 'border-neutral-900 dark:border-white scale-110' : 'border-transparent'
          }`}
          style={{ backgroundColor: c }}
          aria-label={`Select color ${c}`}
        />
      ))}
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-6 h-6 rounded cursor-pointer border border-neutral-300"
        aria-label="Custom color"
      />
    </div>
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

function CategoryRow({
  category,
  onUpdated,
  onDeleted,
}: {
  category: Category;
  onUpdated: (updated: Category) => void;
  onDeleted: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(category.name);
  const [editColor, setEditColor] = useState(category.color ?? '#6b7280');
  const [editIcon, setEditIcon] = useState(category.icon ?? '');
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
      const updated = await updateCategory(category.id, {
        name: editName.trim(),
        color: editColor || undefined,
        icon: editIcon.trim() || undefined,
      });
      onUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteCategory(category.id);
      onDeleted(category.id);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  const canDelete = category.movement_count === 0;

  return (
    <li className="flex items-center gap-3 p-3 bg-white dark:bg-neutral-800 rounded-lg border border-neutral-100 dark:border-neutral-700">
      <div
        data-testid="color-swatch"
        className="w-6 h-6 rounded-full flex-shrink-0"
        style={{ backgroundColor: editing ? editColor : (category.color ?? '#6b7280') }}
      />

      {editing ? (
        <div className="flex flex-col gap-2 flex-1">
          <input
            ref={nameInputRef}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
            onBlur={saveEdit}
            className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white w-full"
            disabled={saving}
          />
          <ColorPicker value={editColor} onChange={setEditColor} />
          <input
            value={editIcon}
            onChange={(e) => setEditIcon(e.target.value)}
            placeholder="Emoji (optional)"
            className="text-sm border border-neutral-300 dark:border-neutral-600 rounded px-2 py-1 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white w-24"
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center gap-2">
          <span className="text-sm font-medium text-neutral-900 dark:text-white">{category.name}</span>
          {category.icon && <span className="text-base">{category.icon}</span>}
        </div>
      )}

      <span className="text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 rounded-full px-2 py-0.5 font-medium">
        {category.movement_count}
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
            title={!canDelete ? `Cannot delete: ${category.movement_count} movement(s) linked` : undefined}
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

function AddCategoryForm({ onCreated }: { onCreated: (cat: Category) => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[3]);
  const [icon, setIcon] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const created = await createCategory({
        name: name.trim(),
        color: color || undefined,
        icon: icon.trim() || undefined,
      });
      onCreated(created);
      setName('');
      setIcon('');
      setColor(PRESET_COLORS[3]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 mb-4">
      <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-200 mb-3">Add Category</h2>
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Category name"
            className="flex-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
            disabled={submitting}
          />
          <input
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="Emoji"
            className="w-20 text-sm border border-neutral-300 dark:border-neutral-600 rounded px-3 py-2 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white"
            disabled={submitting}
          />
        </div>
        <ColorPicker value={color} onChange={setColor} />
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="self-start bg-primary-600 hover:bg-primary-700 disabled:bg-neutral-300 dark:disabled:bg-neutral-600 text-white text-sm font-medium rounded px-4 py-2 transition-colors"
        >
          {submitting ? 'Adding…' : 'Add Category'}
        </button>
      </div>
    </form>
  );
}

export function Categories() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getCategories()
      .then(setCategories)
      .finally(() => setLoading(false));
  }, []);

  function handleCreated(cat: Category) {
    setCategories((prev) => [...prev, cat].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function handleUpdated(updated: Category) {
    setCategories((prev) =>
      prev
        .map((c) => (c.id === updated.id ? updated : c))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  }

  function handleDeleted(id: number) {
    setCategories((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <main className="flex-1 overflow-y-auto p-6">
      <h1 className="text-2xl font-semibold text-neutral-900 dark:text-white mb-6">Categories</h1>

      <AddCategoryForm onCreated={handleCreated} />

      {loading ? (
        <div data-testid="categories-skeleton" className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : categories.length === 0 ? (
        <div className="text-center py-16 text-neutral-400">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
          </svg>
          <p className="text-sm font-medium">Create your first category</p>
          <p className="text-xs mt-1">Use the form above to get started.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {categories.map((cat) => (
            <CategoryRow
              key={cat.id}
              category={cat}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
