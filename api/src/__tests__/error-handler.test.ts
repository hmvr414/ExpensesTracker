import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { errorHandler } from '../middleware/errorHandler';

function makeTestApp() {
  const app = express();
  app.get('/test-error', (_req: Request, _res: Response, next: NextFunction) => {
    next(new Error('boom'));
  });
  app.get('/test-string-error', (_req: Request, _res: Response, next: NextFunction) => {
    next('plain string error');
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  const app = makeTestApp();

  it('returns 500 with { error: "Internal server error" }', async () => {
    const res = await request(app).get('/test-error');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('does not expose the error stack trace in the response body', async () => {
    const res = await request(app).get('/test-error');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Error:');
    expect(body).not.toContain('at ');
  });

  it('handles non-Error thrown values', async () => {
    const res = await request(app).get('/test-string-error');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });

  it('suppresses console.error in production', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      await request(app).get('/test-error');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
      spy.mockRestore();
    }
  });

  it('suppresses console.error in test mode', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      await request(app).get('/test-error');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = originalEnv;
      spy.mockRestore();
    }
  });

  it('logs console.error in development', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    try {
      await request(app).get('/test-error');
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    } finally {
      process.env.NODE_ENV = originalEnv;
      spy.mockRestore();
    }
  });
});
