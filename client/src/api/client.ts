import axios from 'axios';

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public details?: Record<string, string>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface AxiosLikeError {
  isAxiosError: true;
  response: {
    data: { error?: string; details?: Record<string, string> };
    status: number;
  };
}

function isAxiosLike(err: unknown): err is AxiosLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'isAxiosError' in err &&
    (err as Record<string, unknown>).isAxiosError === true &&
    'response' in err &&
    (err as Record<string, unknown>).response != null
  );
}

function handleError(err: unknown): never {
  if (isAxiosLike(err)) {
    const data = err.response.data;
    throw new ApiError(data.error ?? 'Request failed', err.response.status, data.details);
  }
  if (err instanceof Error) {
    throw new ApiError(err.message);
  }
  throw new ApiError('Unknown error');
}

export const apiClient = {
  async get<T>(url: string, config?: Parameters<typeof axios.get>[1]): Promise<T> {
    try {
      const res = await axios.get<T>(url, config);
      return res.data;
    } catch (err) {
      handleError(err);
    }
  },

  async post<T>(url: string, data?: unknown, config?: Parameters<typeof axios.post>[2]): Promise<T> {
    try {
      const res = await axios.post<T>(url, data, config);
      return res.data;
    } catch (err) {
      handleError(err);
    }
  },

  async put<T>(url: string, data?: unknown): Promise<T> {
    try {
      const res = await axios.put<T>(url, data);
      return res.data;
    } catch (err) {
      handleError(err);
    }
  },

  async delete<T>(url: string): Promise<T> {
    try {
      const res = await axios.delete<T>(url);
      return res.data;
    } catch (err) {
      handleError(err);
    }
  },
};
