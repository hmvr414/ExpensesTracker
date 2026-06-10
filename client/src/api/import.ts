import axios from 'axios';

export interface ExtractedMovement {
  amount: number;
  date: string;
  description: string | null;
  store: string | null;
  categoryId: number | null;
  categoryName: string | null;
  color: string | null;
  aiSuggested: boolean;
}

export interface ExtractResponse {
  attachmentId: number;
  rawText: string;
  movements: ExtractedMovement[];
  error?: string;
}

export interface ConfirmMovementInput {
  amount: number;
  date: string;
  description?: string;
  store?: string;
  category_id?: number | null;
}

export interface ConfirmInput {
  attachmentId?: number;
  movements: ConfirmMovementInput[];
}

export interface ConfirmResponse {
  created: { id: number; amount: string; date: string; description: string | null }[];
  count: number;
}

export async function extractFromImage(formData: FormData): Promise<ExtractResponse> {
  const res = await axios.post<ExtractResponse>('/api/import/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function confirmImport(input: ConfirmInput): Promise<ConfirmResponse> {
  const res = await axios.post<ConfirmResponse>('/api/import/confirm', input);
  return res.data;
}
