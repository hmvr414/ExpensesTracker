import { z } from 'zod';

// Wall-clock time as printed on a receipt/notification — no timezone.
// Accepts 'HH:MM' or 'HH:MM:SS' (24h); hours 00–23, minutes/seconds 00–59.
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const TIME_FIELD = z
  .string()
  .regex(TIME_RE, "time must be 'HH:MM' or 'HH:MM:SS' (24-hour)")
  .nullable();

// Postgres `time` column values are stored as HH:MM:SS.
export function normalizeTime(time: string | null | undefined): string | null {
  if (time == null) return null;
  return time.length === 5 ? `${time}:00` : time;
}
