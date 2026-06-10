import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import db from '../db';

const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

function getUploadDir(): string {
  return process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
}

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const dest = path.join(getUploadDir(), month);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, '_');
    const unique = `${base}-${Date.now()}${ext}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter(_req, file, cb) {
    if (ALLOWED_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

const router = Router();

router.post('/', (req: Request, res: Response) => {
  upload.single('file')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'File size exceeds the 10 MB limit' });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }
    if (err) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const { file } = req;
    const movementId = req.body.movement_id
      ? parseInt(req.body.movement_id as string, 10)
      : null;

    const uploadRoot = getUploadDir();
    const relativePath = path.relative(uploadRoot, file.path);
    const publicUrl = `/uploads/${relativePath.replace(/\\/g, '/')}`;

    try {
      const result = await db.query(
        `INSERT INTO attachments (movement_id, file_name, file_path, mime_type)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [movementId, file.originalname, file.path, file.mimetype]
      );
      res.status(201).json({ ...result.rows[0], url: publicUrl });
    } catch (dbErr) {
      // Clean up orphan file if DB insert fails
      try { await fsp.unlink(file.path); } catch { /* ignore */ }
      throw dbErr;
    }
  });
});

router.delete('/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);

  const result = await db.query<{ file_path: string }>(
    `DELETE FROM attachments WHERE id = $1 RETURNING file_path`,
    [id]
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: `Attachment ${id} not found` });
    return;
  }

  const { file_path } = result.rows[0];
  try {
    await fsp.unlink(file_path);
  } catch {
    // ignore missing file
  }

  res.status(204).send();
});

export default router;
