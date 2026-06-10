import request from 'supertest';
import { Pool } from 'pg';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createApp } from '../app';
import { resetPool } from '../db';

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:password@localhost:5433/expenses_test';

const apiRoot = path.resolve(__dirname, '../../');

let uploadDir: string;

function setupSuite() {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
    process.env.UPLOAD_DIR = uploadDir;

    execSync('node-pg-migrate up --migrations-dir migrations', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      stdio: 'pipe',
    });
    pool = new Pool({ connectionString: TEST_DB_URL });
    process.env.DATABASE_URL = TEST_DB_URL;
    resetPool();
    app = createApp();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM attachments WHERE file_name LIKE '__test_%'`);
    await pool.query(`DELETE FROM movements WHERE description LIKE '__test_%'`);
    await pool.query(`DELETE FROM categories WHERE name LIKE '__test_%'`);
    await pool.end();
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  return { getPool: () => pool, getApp: () => app };
}

// --- POST /api/attachments ---

describe('POST /api/attachments', () => {
  const { getPool, getApp } = setupSuite();
  let movementId: number;

  beforeAll(async () => {
    const pool = getPool();
    const cat = await pool.query<{ id: number }>(
      `INSERT INTO categories (name, color) VALUES ('__test_att_cat__', '#112233') RETURNING id`
    );
    const mv = await pool.query<{ id: number }>(
      `INSERT INTO movements (amount, date, description) VALUES (10, '2024-03-01', '__test_att_mv__') RETURNING id`
    );
    movementId = mv.rows[0].id;
  });

  it('201: uploads a JPEG and returns attachment record with url', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('fake-jpeg-data'), {
        filename: '__test_upload.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.file_name).toBe('__test_upload.jpg');
    expect(res.body.mime_type).toBe('image/jpeg');
    expect(res.body.movement_id).toBeNull();
    expect(res.body.url).toMatch(/^\/uploads\//);

    // file should exist on disk
    const filePath = res.body.file_path;
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('201: uploads a PNG linked to a movement', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .field('movement_id', String(movementId))
      .attach('file', Buffer.from('fake-png-data'), {
        filename: '__test_upload.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body.movement_id).toBe(movementId);
    expect(res.body.mime_type).toBe('image/png');
    expect(res.body.url).toMatch(/^\/uploads\//);
  });

  it('201: uploads a PDF with webp MIME', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('fake-webp-data'), {
        filename: '__test_upload.webp',
        contentType: 'image/webp',
      });

    expect(res.status).toBe(201);
    expect(res.body.mime_type).toBe('image/webp');
  });

  it('201: uploads a PDF', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('%PDF-fake'), {
        filename: '__test_upload.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(201);
    expect(res.body.mime_type).toBe('application/pdf');
  });

  it('400: rejects an unsupported MIME type', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('data'), {
        filename: '__test_upload.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported/i);
  });

  it('400: returns 400 when no file is provided', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('stores file under UPLOAD_DIR/YYYY-MM/ subdirectory', async () => {
    const res = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('jpeg-data-2'), {
        filename: '__test_dir_check.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(201);
    const filePath: string = res.body.file_path;
    expect(filePath).toContain(uploadDir);
    // path should include a YYYY-MM subdirectory
    expect(filePath).toMatch(/\d{4}-\d{2}/);
  });
});

// --- DELETE /api/attachments/:id ---

describe('DELETE /api/attachments/:id', () => {
  const { getPool, getApp } = setupSuite();

  it('204: deletes attachment DB record and file from disk', async () => {
    // Upload first
    const uploadRes = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('delete-me'), {
        filename: '__test_delete.jpg',
        contentType: 'image/jpeg',
      });
    expect(uploadRes.status).toBe(201);
    const { id, file_path } = uploadRes.body;

    expect(fs.existsSync(file_path)).toBe(true);

    const deleteRes = await request(getApp()).delete(`/api/attachments/${id}`);
    expect(deleteRes.status).toBe(204);

    // file should be gone
    expect(fs.existsSync(file_path)).toBe(false);

    // DB record should be gone
    const pool = getPool();
    const row = await pool.query(`SELECT id FROM attachments WHERE id = $1`, [id]);
    expect(row.rowCount).toBe(0);
  });

  it('204: succeeds even when file is already missing from disk', async () => {
    // Insert attachment row pointing to a nonexistent file
    const pool = getPool();
    const row = await pool.query<{ id: number }>(
      `INSERT INTO attachments (file_name, file_path, mime_type)
       VALUES ('__test_missing.jpg', '/tmp/__nonexistent_file__.jpg', 'image/jpeg')
       RETURNING id`
    );
    const id = row.rows[0].id;

    const res = await request(getApp()).delete(`/api/attachments/${id}`);
    expect(res.status).toBe(204);
  });

  it('404: returns 404 for unknown id', async () => {
    const res = await request(getApp()).delete('/api/attachments/999999');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

// --- GET /uploads/:path (static file serving) ---

describe('GET /uploads/:path', () => {
  const { getApp } = setupSuite();

  it('serves an uploaded file with correct Content-Type', async () => {
    const uploadRes = await request(getApp())
      .post('/api/attachments')
      .attach('file', Buffer.from('\xff\xd8\xff\xe0'), {
        filename: '__test_serve.jpg',
        contentType: 'image/jpeg',
      });
    expect(uploadRes.status).toBe(201);

    const url: string = uploadRes.body.url; // e.g. /uploads/2024-03/__test_serve-<hash>.jpg
    const res = await request(getApp()).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
  });
});
