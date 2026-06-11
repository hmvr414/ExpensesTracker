import axios from 'axios';

export type PaymentMethodKind = 'card' | 'cash' | 'bank_transfer' | 'other';
export type PaymentMethodBrand = 'visa' | 'mastercard' | 'amex' | 'other';

export interface PaymentMethod {
  id: number;
  name: string;
  kind: PaymentMethodKind;
  brand: PaymentMethodBrand | null;
  variant: string | null;
  last4: string | null;
  movement_count: number;
  created_at: string;
}

export interface CreatePaymentMethodInput {
  name: string;
  kind: PaymentMethodKind;
  brand?: PaymentMethodBrand;
  variant?: string;
  last4?: string;
}

export interface UpdatePaymentMethodInput {
  name?: string;
  kind?: PaymentMethodKind;
  brand?: PaymentMethodBrand;
  variant?: string;
  last4?: string;
}

export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const res = await axios.get<PaymentMethod[]>('/api/payment-methods');
  return res.data;
}

export async function createPaymentMethod(
  input: CreatePaymentMethodInput
): Promise<PaymentMethod> {
  const res = await axios.post<PaymentMethod>('/api/payment-methods', input);
  return res.data;
}

export async function updatePaymentMethod(
  id: number,
  input: UpdatePaymentMethodInput
): Promise<PaymentMethod> {
  const res = await axios.put<PaymentMethod>(`/api/payment-methods/${id}`, input);
  return res.data;
}

export async function deletePaymentMethod(id: number): Promise<void> {
  await axios.delete(`/api/payment-methods/${id}`);
}
