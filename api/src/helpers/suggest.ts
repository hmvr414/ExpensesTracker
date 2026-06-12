import OpenAI from 'openai';
import db from '../db';
import { getStoreContext, getRecentStoreDescriptions } from './storeContext';

interface Category {
  id: number;
  name: string;
  color: string | null;
}

export interface SuggestResult {
  categoryId: number | null;
  categoryName?: string;
  color?: string;
  suggestedNewCategory?: string | null;
}

const TIMEOUT_MS = 3000;

const KEYWORD_CATEGORY_RULES: Array<{
  patterns: RegExp[];
  categoryNames: string[];
}> = [
  {
    patterns: [
      /\b(parking|parqueadero|estacionamiento|bicycle parking|bike parking)\b/i,
      /\b(taxi|uber|cabify|bus|metro|transmilenio|gasolina|fuel)\b/i,
    ],
    categoryNames: ['Transport'],
  },
  {
    patterns: [
      /\b(restaurant|restaurante|starbucks|coffee|cafe|cafeteria|burger|pizza)\b/i,
      /\b(comida|almuerzo|cena|breakfast|lunch|dinner|takeout)\b/i,
    ],
    categoryNames: ['Dining Out', 'Food'],
  },
  {
    patterns: [
      /\b(gym|gimnasio|fitness|workout|sports|deporte|protein|water bottle)\b/i,
    ],
    categoryNames: ['Fitness', 'Health'],
  },
  {
    patterns: [
      /\b(pharmacy|farmacia|drugstore|medicine|medication|medicina|salud)\b/i,
    ],
    categoryNames: ['Health'],
  },
  {
    patterns: [
      /\b(openrouter|anthropic|aws|amazon web services|digitalocean|cloud|hosting)\b/i,
      /\b(api credits|ai bill|ai bills|server|hardware|domain|dns|infra)\b/i,
    ],
    categoryNames: ['Tech Infrastructure'],
  },
  {
    patterns: [
      /\b(grocery|groceries|supermarket|mercado|verduras|fruit|vegetables)\b/i,
      /\b(exito|carulla|jumbo|d1|ara)\b/i,
    ],
    categoryNames: ['Groceries', 'Groseries', 'Food'],
  },
];

async function completeJson(
  client: OpenAI,
  model: string,
  prompt: string
): Promise<string | null> {
  const completion = await Promise.race([
    client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)
    ),
  ]);
  return completion.choices[0]?.message?.content ?? null;
}

function sanitizeSuggestedName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  return trimmed;
}

function normalizeText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function toSuggestResult(category: Category): SuggestResult {
  return {
    categoryId: category.id,
    categoryName: category.name,
    ...(category.color != null ? { color: category.color } : {}),
    suggestedNewCategory: null,
  };
}

function findCategoryByNames(categories: Category[], names: string[]): Category | undefined {
  const normalizedNames = names.map(normalizeText);
  return categories.find(c => normalizedNames.includes(normalizeText(c.name)));
}

function suggestFromKeywords(
  store: string | undefined,
  description: string | undefined,
  categories: Category[]
): SuggestResult | null {
  const text = normalizeText(`${store ?? ''} ${description ?? ''}`);
  if (text.trim() === '') return null;

  for (const rule of KEYWORD_CATEGORY_RULES) {
    if (!rule.patterns.some(pattern => pattern.test(text))) continue;
    const category = findCategoryByNames(categories, rule.categoryNames);
    if (category) return toSuggestResult(category);
  }

  return null;
}

// Store knowledge shared by both passes: a cached web summary of what the
// merchant sells, plus the user's own recent descriptions for the store.
function buildStoreContextLines(
  storeContext: string | null,
  priorDescriptions: string[]
): string[] {
  const lines: string[] = [];
  if (storeContext != null) {
    lines.push(`Store context (what this merchant sells): ${storeContext}`, '');
  }
  if (priorDescriptions.length > 0) {
    lines.push(
      'Descriptions this user previously wrote for this store (prefer consistency with their wording):',
      ...priorDescriptions.map(d => `- ${d}`),
      ''
    );
  }
  return lines;
}

async function suggestNewCategoryName(
  client: OpenAI,
  model: string,
  store: string | undefined,
  description: string | undefined,
  categories: Category[],
  contextLines: string[]
): Promise<string | null> {
  const prompt = [
    'No existing category matched this expense:',
    `Store: ${store ?? 'N/A'}`,
    `Description: ${description ?? 'N/A'}`,
    '',
    ...contextLines,
    categories.length > 0
      ? "The user's existing categories (for language and naming style reference):"
      : 'The user has no categories yet.',
    ...categories.map(c => `- ${c.name}`),
    '',
    'Propose a concise new category name that would fit this expense:',
    '- 1 to 2 words, capitalized (e.g. "Software", "AI Services")',
    "- In the same language as the user's existing categories",
    '',
    'Return JSON: { "newCategoryName": "<string>" }',
    'Use null for newCategoryName when you cannot propose a sensible category.',
  ].join('\n');

  try {
    const content = await completeJson(client, model, prompt);
    if (!content) return null;
    const parsed = JSON.parse(content) as { newCategoryName?: unknown };
    return sanitizeSuggestedName(parsed.newCategoryName);
  } catch {
    return null;
  }
}

export async function suggestCategory(
  store?: string,
  description?: string
): Promise<SuggestResult> {
  const categoriesResult = await db.query<Category>(
    'SELECT id, name, color FROM categories ORDER BY name ASC'
  );
  const categories = categoriesResult.rows;

  const keywordSuggestion = suggestFromKeywords(store, description, categories);
  if (keywordSuggestion) return keywordSuggestion;

  // Both never throw; getStoreContext web-searches a store at most once ever.
  const [priorDescriptions, storeContext] = await Promise.all([
    getRecentStoreDescriptions(store),
    getStoreContext(store),
  ]);
  const contextLines = buildStoreContextLines(storeContext, priorDescriptions);

  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5';

  if (categories.length === 0) {
    return {
      categoryId: null,
      suggestedNewCategory: await suggestNewCategoryName(
        client, model, store, description, categories, contextLines
      ),
    };
  }

  const prompt = [
    'Given this expense:',
    `Store: ${store ?? 'N/A'}`,
    `Description: ${description ?? 'N/A'}`,
    '',
    ...contextLines,
    'Available categories:',
    ...categories.map(c => `- ID: ${c.id}, Name: ${c.name}`),
    '',
    'Return JSON: { "categoryId": <number or null>, "reason": "<string>" }',
    'Use null for categoryId when no category fits well.',
  ].join('\n');

  try {
    const content = await completeJson(client, model, prompt);
    if (!content) return { categoryId: null, suggestedNewCategory: null };

    const parsed = JSON.parse(content) as { categoryId: number | null };
    const matched =
      parsed.categoryId == null
        ? undefined
        : categories.find(c => c.id === parsed.categoryId);

    if (matched) {
      return {
        categoryId: matched.id,
        categoryName: matched.name,
        ...(matched.color != null ? { color: matched.color } : {}),
        suggestedNewCategory: null,
      };
    }
  } catch {
    // First pass failed (timeout, network, bad JSON): skip the second
    // pass rather than stacking another call on a struggling backend.
    return { categoryId: null, suggestedNewCategory: null };
  }

  return {
    categoryId: null,
    suggestedNewCategory: await suggestNewCategoryName(
      client, model, store, description, categories, contextLines
    ),
  };
}
