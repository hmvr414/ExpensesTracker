import express, { Request, Response } from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import categoriesRouter from './routes/categories';
import paymentMethodsRouter from './routes/payment-methods';
import movementsRouter from './routes/movements';
import attachmentsRouter from './routes/attachments';
import suggestRouter from './routes/suggest';
import importRouter from './routes/import';
import dashboardRouter from './routes/dashboard';
import { errorHandler } from './middleware/errorHandler';

const VERSION = process.env.npm_package_version ?? '1.0.0';

export function createApp(): express.Application {
  const app = express();

  const allowedOrigins = process.env.NODE_ENV === 'production'
    ? (process.env.CORS_ORIGIN ?? '').split(',').map(o => o.trim()).filter(Boolean)
    : ['http://localhost:5173'];

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
  }));

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: VERSION,
    });
  });

  const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadDir));

  app.use('/api/categories', categoriesRouter);
  app.use('/api/payment-methods', paymentMethodsRouter);
  app.use('/api/movements', movementsRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/suggest', suggestRouter);
  app.use('/api/import', importRouter);
  app.use('/api/dashboard', dashboardRouter);

  if (process.env.NODE_ENV === 'production') {
    const clientDist = path.resolve(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);

  return app;
}
