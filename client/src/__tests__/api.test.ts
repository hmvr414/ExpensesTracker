import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

const mockedAxios = vi.mocked(axios, true);

describe('API client error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('surfaces API error payload as typed exception', async () => {
    const { apiClient } = await import('../api/client');

    const axiosError = {
      isAxiosError: true,
      response: {
        data: { error: 'Validation failed', details: { amount: 'required' } },
        status: 400,
      },
    };
    mockedAxios.get = vi.fn().mockRejectedValueOnce(axiosError);

    await expect(apiClient.get('/api/movements')).rejects.toMatchObject({
      message: 'Validation failed',
      details: { amount: 'required' },
      status: 400,
    });
  });

  it('wraps non-API errors with a generic message', async () => {
    const { apiClient } = await import('../api/client');

    mockedAxios.get = vi.fn().mockRejectedValueOnce(new Error('Network Error'));

    await expect(apiClient.get('/api/movements')).rejects.toMatchObject({
      message: 'Network Error',
    });
  });

  it('returns data on success', async () => {
    const { apiClient } = await import('../api/client');

    mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { ok: true } });

    const result = await apiClient.get('/api/health');
    expect(result).toEqual({ ok: true });
  });
});

describe('categories API module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('getCategories calls GET /api/categories', async () => {
    mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: [] });
    const { getCategories } = await import('../api/categories');
    await getCategories();
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/categories');
  });

  it('createCategory calls POST /api/categories', async () => {
    mockedAxios.post = vi.fn().mockResolvedValueOnce({ data: { id: 1 } });
    const { createCategory } = await import('../api/categories');
    await createCategory({ name: 'Food', color: '#ff0000' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/categories', {
      name: 'Food',
      color: '#ff0000',
    });
  });

  it('updateCategory calls PUT /api/categories/:id', async () => {
    mockedAxios.put = vi.fn().mockResolvedValueOnce({ data: { id: 1 } });
    const { updateCategory } = await import('../api/categories');
    await updateCategory(1, { name: 'Updated' });
    expect(mockedAxios.put).toHaveBeenCalledWith('/api/categories/1', { name: 'Updated' });
  });

  it('deleteCategory calls DELETE /api/categories/:id', async () => {
    mockedAxios.delete = vi.fn().mockResolvedValueOnce({ data: undefined });
    const { deleteCategory } = await import('../api/categories');
    await deleteCategory(1);
    expect(mockedAxios.delete).toHaveBeenCalledWith('/api/categories/1');
  });
});

describe('movements API module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('getMovements calls GET /api/movements with query params', async () => {
    mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: { data: [], total: 0 } });
    const { getMovements } = await import('../api/movements');
    await getMovements({ from: '2026-01-01', category_id: 2, page: 1, limit: 20 });
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/movements', {
      params: { from: '2026-01-01', category_id: 2, page: 1, limit: 20 },
    });
  });

  it('createMovement calls POST /api/movements', async () => {
    mockedAxios.post = vi.fn().mockResolvedValueOnce({ data: { id: 1 } });
    const { createMovement } = await import('../api/movements');
    await createMovement({ amount: 10.5, date: '2026-06-09' });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/movements', {
      amount: 10.5,
      date: '2026-06-09',
    });
  });

  it('deleteMovement calls DELETE /api/movements/:id', async () => {
    mockedAxios.delete = vi.fn().mockResolvedValueOnce({ data: undefined });
    const { deleteMovement } = await import('../api/movements');
    await deleteMovement(5);
    expect(mockedAxios.delete).toHaveBeenCalledWith('/api/movements/5');
  });
});

describe('dashboard API module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('getDashboard calls GET /api/dashboard with period and anchor', async () => {
    mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: {} });
    const { getDashboard } = await import('../api/dashboard');
    await getDashboard({ period: 'month', anchor: '2026-06-01' });
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/dashboard', {
      params: { period: 'month', anchor: '2026-06-01' },
    });
  });

  it('getDashboard calls GET /api/dashboard with period only', async () => {
    mockedAxios.get = vi.fn().mockResolvedValueOnce({ data: {} });
    const { getDashboard } = await import('../api/dashboard');
    await getDashboard({ period: 'week' });
    expect(mockedAxios.get).toHaveBeenCalledWith('/api/dashboard', {
      params: { period: 'week' },
    });
  });
});

describe('import API module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('extractFromImage calls POST /api/import/extract with FormData', async () => {
    mockedAxios.post = vi.fn().mockResolvedValueOnce({ data: { attachmentId: 1 } });
    const { extractFromImage } = await import('../api/import');
    const fd = new FormData();
    await extractFromImage(fd);
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/import/extract', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  });

  it('confirmImport calls POST /api/import/confirm', async () => {
    mockedAxios.post = vi.fn().mockResolvedValueOnce({ data: { created: [], count: 0 } });
    const { confirmImport } = await import('../api/import');
    await confirmImport({ attachmentId: 1, movements: [] });
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/import/confirm', {
      attachmentId: 1,
      movements: [],
    });
  });
});
