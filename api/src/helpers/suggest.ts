import OpenAI from 'openai';
import db from '../db';

interface Category {
  id: number;
  name: string;
  color: string | null;
}

export interface SuggestResult {
  categoryId: number | null;
  categoryName?: string;
  color?: string;
}

export async function suggestCategory(
  store?: string,
  description?: string
): Promise<SuggestResult> {
  const categoriesResult = await db.query<Category>(
    'SELECT id, name, color FROM categories ORDER BY name ASC'
  );
  const categories = categoriesResult.rows;

  if (categories.length === 0) {
    return { categoryId: null };
  }

  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    baseURL: 'https://openrouter.ai/api/v1',
  });

  const model = process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4-5';

  const prompt = [
    'Given this expense:',
    `Store: ${store ?? 'N/A'}`,
    `Description: ${description ?? 'N/A'}`,
    '',
    'Available categories:',
    ...categories.map(c => `- ID: ${c.id}, Name: ${c.name}`),
    '',
    'Return JSON: { "categoryId": <number or null>, "reason": "<string>" }',
    'Use null for categoryId when no category fits well.',
  ].join('\n');

  try {
    const completion = await Promise.race([
      client.chat.completions.create({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 3000)
      ),
    ]);

    const content = completion.choices[0]?.message?.content;
    if (!content) return { categoryId: null };

    const parsed = JSON.parse(content) as { categoryId: number | null };
    if (parsed.categoryId == null) return { categoryId: null };

    const matched = categories.find(c => c.id === parsed.categoryId);
    if (!matched) return { categoryId: null };

    return {
      categoryId: matched.id,
      categoryName: matched.name,
      ...(matched.color != null ? { color: matched.color } : {}),
    };
  } catch {
    return { categoryId: null };
  }
}
