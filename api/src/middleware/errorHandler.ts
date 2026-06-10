import { Request, Response, NextFunction } from 'express';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const stack = err instanceof Error ? err.stack : String(err);
  if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production') {
    console.error(stack);
  }
  res.status(500).json({ error: 'Internal server error' });
}
