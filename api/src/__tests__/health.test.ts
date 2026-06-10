import request from 'supertest';
import { createApp } from '../app';

describe('GET /health', () => {
  const app = createApp();

  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.timestamp).toBeDefined();
    expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
  });

  it('returns the server version', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBeDefined();
    expect(typeof res.body.version).toBe('string');
  });
});

describe('CORS middleware', () => {
  const app = createApp();

  it('allows requests from the Vite dev origin', async () => {
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
