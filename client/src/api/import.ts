import axios from 'axios';
import { ResolvedCategory } from './categories';

export interface ExtractedMovement {
  amount: number;
  // Amount string exactly as it appeared on the receipt; non-null when the
  // server flagged the parsed amount as suspect
  rawAmountText?: string | null;
  amountSuspect?: boolean;
  date: string;
  time?: string | null;
  description: string | null;
  store: string | null;
  possibleDuplicate?: boolean;
  duplicateOf?: {
    id: number | null;
    date: string;
    time: string | null;
    description: string | null;
  } | null;
  categoryId: number | null;
  categoryName: string | null;
  color: string | null;
  aiSuggested: boolean;
  suggestedNewCategory: string | null;
  paymentMethodId: number | null;
  paymentMethodName: string | null;
  detectedPaymentLabel: string | null;
  detectedBrand: string | null;
  detectedVariant: string | null;
  paymentAiSuggested: boolean;
  // Present on movements extracted from Gmail emails
  gmailMessageId?: string;
  source?: 'gmail';
}

export interface ExtractResponse {
  attachmentId: number;
  rawText: string;
  language?: string | null;
  movements: ExtractedMovement[];
  error?: string;
}

export interface ExtractEmailResult {
  messageId: string;
  subject?: string | null;
  from?: string | null;
  date?: string | null;
  movements: ExtractedMovement[];
  error: string | null;
}

export interface ExtractEmailsResponse {
  emails: ExtractEmailResult[];
  language?: string | null;
}

export interface ConfirmMovementInput {
  amount: number;
  date: string;
  time?: string | null;
  description?: string;
  store?: string;
  category_id?: number | null;
  new_category_name?: string;
  payment_method_id?: number | null;
  gmail_message_id?: string;
}

export interface ConfirmInput {
  attachmentId?: number;
  movements: ConfirmMovementInput[];
}

export interface ConfirmResponse {
  created: {
    id: number;
    amount: string;
    date: string;
    description: string | null;
    store: string | null;
    category_id: number | null;
    payment_method_id: number | null;
  }[];
  count: number;
  resolvedCategories: ResolvedCategory[];
}

export async function extractFromImage(formData: FormData): Promise<ExtractResponse> {
  const res = await axios.post<ExtractResponse>('/api/import/extract', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function extractFromEmails(messageIds: string[]): Promise<ExtractEmailsResponse> {
  const res = await axios.post<ExtractEmailsResponse>('/api/import/extract-emails', { messageIds });
  return res.data;
}

export async function confirmImport(input: ConfirmInput): Promise<ConfirmResponse> {
  const res = await axios.post<ConfirmResponse>('/api/import/confirm', input);
  return res.data;
}
