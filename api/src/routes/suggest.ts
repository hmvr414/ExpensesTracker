import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { suggestCategory } from '../helpers/suggest';

const router = Router();

const suggestSchema = z
  .object({
    store: z.string().optional(),
    description: z.string().optional(),
  })
  .refine(data => data.store !== undefined || data.description !== undefined, {
    message: 'At least one of store or description is required',
  });

router.post('/category', async (req: Request, res: Response) => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    const details: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      details[issue.path.join('.') || 'body'] = issue.message;
    }
    res.status(400).json({ error: 'Validation failed', details });
    return;
  }

  const { store, description } = parsed.data;
  const result = await suggestCategory(store, description);
  res.json(result);
});

export default router;
