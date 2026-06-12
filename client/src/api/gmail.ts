import axios from 'axios';

export interface GmailStatus {
  connected: boolean;
  email: string | null;
  connectedAt: string | null;
  lastPolledAt?: string | null;
  needsReconnect?: boolean;
}

export interface GmailSender {
  id: number;
  email: string;
  label: string | null;
  subject_contains: string | null;
  created_at: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  alreadyImported: boolean;
}

export interface GmailMessagesParams {
  from?: string;
  to?: string;
  sender?: string;
  subject?: string;
  pageToken?: string;
}

export interface GmailMessagesResponse {
  messages: GmailMessage[];
  nextPageToken: string | null;
}

export interface GmailPendingMovement {
  amount: number;
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
  gmailMessageId?: string;
  source?: 'gmail';
}

export interface GmailPendingEmail {
  messageId: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  movements: GmailPendingMovement[];
  status: 'pending' | 'error' | 'dismissed';
  error: string | null;
  detectedAt: string;
  extractedAt: string | null;
}

export interface GmailPendingResponse {
  emails: GmailPendingEmail[];
}

export interface GmailPendingCount {
  emails: number;
  movements: number;
}

export interface GmailPollResult {
  newEmails: number;
  errors: number;
}

export const GMAIL_PENDING_REFRESH_EVENT = 'gmail-pending-count-refresh';

export function requestGmailPendingRefresh() {
  window.dispatchEvent(new Event(GMAIL_PENDING_REFRESH_EVENT));
}

export interface CreateGmailSenderInput {
  email: string;
  label?: string;
  subject_contains?: string;
}

export interface UpdateGmailSenderInput {
  label?: string | null;
  subject_contains?: string | null;
}

export class GmailApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public details?: Record<string, string>
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

interface AxiosLikeError {
  isAxiosError: true;
  response: {
    data: { error?: string; code?: string; details?: Record<string, string> };
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
    throw new GmailApiError(
      data.error ?? 'Request failed',
      err.response.status,
      data.code,
      data.details
    );
  }
  if (err instanceof Error) throw new GmailApiError(err.message);
  throw new GmailApiError('Unknown error');
}

export async function getGmailStatus(): Promise<GmailStatus> {
  try {
    const res = await axios.get<GmailStatus>('/api/gmail/status');
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function getGmailAuthUrl(): Promise<string> {
  try {
    const res = await axios.get<{ url: string }>('/api/gmail/auth-url');
    return res.data.url;
  } catch (err) {
    handleError(err);
  }
}

export async function disconnectGmail(): Promise<void> {
  try {
    await axios.delete('/api/gmail/connection');
  } catch (err) {
    handleError(err);
  }
}

export async function getGmailSenders(): Promise<GmailSender[]> {
  try {
    const res = await axios.get<GmailSender[]>('/api/gmail/senders');
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function createGmailSender(input: CreateGmailSenderInput): Promise<GmailSender> {
  try {
    const res = await axios.post<GmailSender>('/api/gmail/senders', input);
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function updateGmailSender(
  id: number,
  input: UpdateGmailSenderInput
): Promise<GmailSender> {
  try {
    const res = await axios.put<GmailSender>(`/api/gmail/senders/${id}`, input);
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function deleteGmailSender(id: number): Promise<void> {
  try {
    await axios.delete(`/api/gmail/senders/${id}`);
  } catch (err) {
    handleError(err);
  }
}

export async function getGmailMessages(params: GmailMessagesParams): Promise<GmailMessagesResponse> {
  try {
    const cleaned = Object.fromEntries(
      Object.entries(params).filter(([, value]) => value != null && value !== '')
    );
    const res = await axios.get<GmailMessagesResponse>('/api/gmail/messages', {
      params: cleaned,
    });
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function getGmailPending(status: 'pending' | 'error' = 'pending'): Promise<GmailPendingResponse> {
  try {
    const res = await axios.get<GmailPendingResponse>('/api/gmail/pending', {
      params: { status },
    });
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function getGmailPendingCount(): Promise<GmailPendingCount> {
  try {
    const res = await axios.get<GmailPendingCount>('/api/gmail/pending/count');
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function dismissGmailPending(messageId: string): Promise<void> {
  try {
    await axios.post(`/api/gmail/pending/${encodeURIComponent(messageId)}/dismiss`);
  } catch (err) {
    handleError(err);
  }
}

export async function retryGmailPending(messageId: string): Promise<GmailPollResult> {
  try {
    const res = await axios.post<GmailPollResult>(`/api/gmail/pending/${encodeURIComponent(messageId)}/retry`);
    return res.data;
  } catch (err) {
    handleError(err);
  }
}

export async function pollGmailNow(): Promise<GmailPollResult> {
  try {
    const res = await axios.post<GmailPollResult>('/api/gmail/poll-now');
    return res.data;
  } catch (err) {
    handleError(err);
  }
}
