import axios from 'axios';
import { PaymentMethodKind, PaymentMethodBrand } from './paymentMethods';
import { ResolvedCategory } from './categories';

export interface MovementPaymentMethod {
  id: number;
  name: string;
  kind: PaymentMethodKind;
  brand: PaymentMethodBrand | null;
  variant: string | null;
}

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
  time?: string | null;
  description: string | null;
  store: string | null;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  payment_method_id: number | null;
  payment_method: MovementPaymentMethod | null;
  attachments: Attachment[];
  created_at: string;
  updated_at: string;
  // Present on create/update responses when the request resolved a category
  // (via new_category_name); absent on list/detail reads.
  category?: ResolvedCategory;
}

export interface MovementsResponse {
  data: Movement[];
  total: number;
  totalAmount: number;
  page: number;
  limit: number;
}

export interface GetMovementsParams {
  from?: string;
  to?: string;
  // A single id stays backward-compatible; a list is serialized as repeated
  // `category_id` query params (handled by the ANY(...) filter on the API).
  category_id?: number | number[];
  uncategorized?: boolean;
  store?: string;
  search?: string;
  payment_method_id?: number;
  page?: number;
  limit?: number;
}

export type MovementsSeriesGranularity = 'hour' | 'day' | 'week' | 'month';

export interface MovementsSeriesPoint {
  label: string;
  total: number;
}

export interface MovementsSeriesComparison {
  previousTotal: number;
  currentTotal: number;
  deltaPct: number | null;
}

export interface MovementsSeriesResponse {
  granularity: MovementsSeriesGranularity;
  data: MovementsSeriesPoint[];
  comparison: MovementsSeriesComparison;
}

export interface GetMovementsSeriesParams {
  from: string;
  to: string;
  category_id?: number | number[];
  uncategorized?: boolean;
  store?: string;
  search?: string;
  payment_method_id?: number;
}

// Serialize query params so array values (e.g. category_id) emit repeated keys
// (`?category_id=3&category_id=7`) and booleans render as `true`/`false`.
function serializeParams(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v != null) sp.append(key, String(v));
      }
    } else {
      sp.append(key, String(value));
    }
  }
  return sp.toString();
}

export interface CreateMovementInput {
  amount: number;
  date?: string;
  time?: string | null;
  description?: string;
  store?: string;
  category_id?: number | null;
  new_category_name?: string;
  payment_method_id?: number | null;
}

export interface UpdateMovementInput {
  amount?: number;
  date?: string;
  time?: string | null;
  description?: string;
  store?: string;
  category_id?: number | null;
  new_category_name?: string;
  payment_method_id?: number | null;
}

export async function getMovements(params?: GetMovementsParams): Promise<MovementsResponse> {
  const res = await axios.get<MovementsResponse>('/api/movements', {
    params,
    paramsSerializer: { serialize: serializeParams },
  });
  return res.data;
}

export async function getMovementsSeries(
  params: GetMovementsSeriesParams
): Promise<MovementsSeriesResponse> {
  const res = await axios.get<MovementsSeriesResponse>('/api/movements/series', {
    params,
    paramsSerializer: { serialize: serializeParams },
  });
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
