import OpenAI from 'openai';
import db from '../db';

// Web enrichment for unknown stores: one OpenRouter call with the web search
// plugin (":online" model suffix) per store, ever. The result — or an empty
// string on failure — is cached in store_context so the store is never
// searched again. Both lookups never throw.

const SEARCH_TIMEOUT_MS = 5000;

// Concurrent lookups for the same new store (e.g. several rows of one
// extraction batch) share a single in-flight web call.
const inFlightSearches = new Map<string, Promise<string | null>>();

export async function getRecentStoreDescriptions(store?: string | null): Promise<string[]> {
  if (store == null || store.trim() === '') return [];
  try {
    const result = await db.query<{ description: string }>(
      `SELECT description FROM movements
       WHERE LOWER(store) = LOWER($1)
         AND description IS NOT NULL AND TRIM(description) <> ''
       GROUP BY description
       ORDER BY MAX(created_at) DESC
       LIMIT 10`,
      [store.trim()]
    );
    return result.rows.map(r => r.description);
  } catch {
    return [];
  }
}

export async function getStoreContext(store?: string | null): Promise<string | null> {
  if (store == null) return null;
  const normalized = store.trim().toLowerCase();
  if (normalized === '') return null;

  try {
    const cached = await db.query<{ summary: string | null }>(
      'SELECT summary FROM store_context WHERE store = $1',
      [normalized]
    );
    if (cached.rows.length > 0) {
      const summary = cached.rows[0].summary;
      return summary != null && summary.trim() !== '' ? summary : null;
    }

    // Stores with prior movements get context from the user's own history
    // instead of the web.
    const prior = await db.query(
      'SELECT 1 FROM movements WHERE LOWER(store) = $1 LIMIT 1',
      [normalized]
    );
    if (prior.rows.length > 0) return null;
  } catch {
    return null;
  }

  let pending = inFlightSearches.get(normalized);
  if (!pending) {
    pending = searchAndCache(store.trim(), normalized).finally(() => {
      inFlightSearches.delete(normalized);
    });
    inFlightSearches.set(normalized, pending);
  }
  return pending;
}

async function searchAndCache(store: string, normalized: string): Promise<string | null> {
  let summary: string | null = null;
  try {
    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY ?? '',
      baseURL: 'https://openrouter.ai/api/v1',
    });
    const model = `${process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5'}:online`;

    const completion = await Promise.race([
      client.chat.completions.create({
        model,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `In one sentence, what does the merchant or company "${store}" sell or provide? Reply with only that sentence. If you cannot find reliable information, reply exactly "unknown".`,
          },
        ],
      }),
      new Promise<never>((_, reject) => {
        // unref so a pending 5 s timer never holds the process open
        setTimeout(() => reject(new Error('store context timeout')), SEARCH_TIMEOUT_MS).unref();
      }),
    ]);

    const content = completion.choices[0]?.message?.content?.trim();
    if (content && !/^"?unknown"?\.?$/i.test(content)) {
      summary = content;
    }
  } catch {
    // Skip silently — the cache row below still marks the store as searched.
  }

  try {
    await db.query(
      `INSERT INTO store_context (store, summary, fetched_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (store) DO NOTHING`,
      [normalized, summary ?? '']
    );
  } catch {
    // Caching is best-effort; the summary (or null) is still returned.
  }

  return summary;
}
