import axios from 'axios';

export interface Attachment {
  id: number;
  file_name: string;
  file_path: string;
  mime_type: string;
  url: string;
  created_at: string;
}

export interface Movement {
  id: number;
  amount: string;
  date: string;
  description: string | null;
  store: string | null;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
}

export interface MovementsResponse {
  data: Movement[];
  total: number;
  page: number;
  limit: number;
}

export interface GetMovementsParams {
  from?: string;
  to?: string;
  category_id?: number;
  store?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateMovementInput {
  amount: number;
  date?: string;
  description?: string;
  store?: string;
  category_id?: number | null;
}

export interface UpdateMovementInput {
  amount?: number;
  date?: string;
  description?: string;
  store?: string;
  category_id?: number | null;
}

export async function getMovements(params?: GetMovementsParams): Promise<MovementsResponse> {
  const res = await axios.get<MovementsResponse>('/api/movements', { params });
  return res.data;
}

export async function getMovement(id: number): Promise<Movement> {
  const res = await axios.get<Movement>(`/api/movements/${id}`);
  return res.data;
}

export async function createMovement(input: CreateMovementInput): Promise<Movement> {
  const res = await axios.post<Movement>('/api/movements', input);
  return res.data;
}

export async function updateMovement(id: number, input: UpdateMovementInput): Promise<Movement> {
  const res = await axios.put<Movement>(`/api/movements/${id}`, input);
  return res.data;
}

export async function deleteMovement(id: number): Promise<void> {
  await axios.delete(`/api/movements/${id}`);
}
