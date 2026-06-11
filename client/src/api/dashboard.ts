import axios from 'axios';

export type DashboardPeriod = 'day' | 'week' | 'month' | 'year' | 'all';

export interface CategoryBreakdown {
  categoryId: number | null;
  name: string;
  color: string | null;
  total: number;
  percentage: number;
}

export interface PaymentMethodBreakdown {
  paymentMethodId: number | null;
  name: string;
  kind: string;
  total: number;
  percentage: number;
}

export interface TimeSeriesBucket {
  label: string;
  total: number;
}

export interface PreviousPeriod {
  totalAmount: number;
  movementCount: number;
}

export interface DashboardData {
  totalAmount: number;
  movementCount: number;
  categoryBreakdown: CategoryBreakdown[];
  paymentMethodBreakdown: PaymentMethodBreakdown[];
  timeSeries: TimeSeriesBucket[];
  previousPeriod: PreviousPeriod;
  topStore: string | null;
}

export interface GetDashboardParams {
  period: DashboardPeriod;
  anchor?: string;
}

export async function getDashboard(params: GetDashboardParams): Promise<DashboardData> {
  const res = await axios.get<DashboardData>('/api/dashboard', { params });
  return res.data;
}
