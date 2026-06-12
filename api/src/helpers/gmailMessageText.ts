export interface GmailPayloadPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayloadPart[] | null;
  headers?: Array<{ name?: string | null; value?: string | null }> | null;
}

export function headerValue(
  headers: Array<{ name?: string | null; value?: string | null }> | null | undefined,
  name: string
): string | null {
  const match = headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
}

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  return Buffer.from(data, 'base64url').toString('utf8');
}

function findMimePart(payload: GmailPayloadPart | null | undefined, mimeType: string): string | null {
  if (!payload) return null;
  if (payload.mimeType?.toLowerCase() === mimeType && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const found = findMimePart(part, mimeType);
    if (found != null) return found;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function textFromPayload(payload: GmailPayloadPart | null | undefined): string {
  const plain = findMimePart(payload, 'text/plain');
  if (plain != null) return plain;
  const html = findMimePart(payload, 'text/html');
  return html != null ? htmlToText(html) : '';
}

export function textWithContext(payload: GmailPayloadPart | null | undefined): {
  rawText: string;
  subject: string | null;
  from: string | null;
  date: string | null;
} {
  const subject = headerValue(payload?.headers, 'Subject');
  const from = headerValue(payload?.headers, 'From');
  const date = headerValue(payload?.headers, 'Date');
  const bodyText = textFromPayload(payload);
  return {
    subject,
    from,
    date,
    rawText: [
      `Subject: ${subject ?? ''}`,
      `From: ${from ?? ''}`,
      `Date: ${date ?? ''}`,
      '',
      bodyText,
    ].join('\n'),
  };
}
