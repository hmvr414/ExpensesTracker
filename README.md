# ExpensesTracker

A personal expense tracking application with OCR-assisted receipt import, AI category suggestions, and a dashboard for spending analytics.

## Stack

- **API**: Node.js + Express + TypeScript, PostgreSQL
- **Client**: React + TypeScript + Vite + Tailwind CSS
- **AI**: OpenRouter (Claude Haiku) for category suggestion and OCR extraction
- **OCR**: Tesseract

## Quick start — bare metal

### Prerequisites

- Node.js 20+
- PostgreSQL 14+
- Tesseract OCR (`sudo apt install tesseract-ocr tesseract-ocr-eng` or `brew install tesseract`)

### Setup

```bash
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and OPENROUTER_API_KEY
```

Install dependencies:

```bash
npm install
npm install --prefix api
npm install --prefix client
```

Run database migrations:

```bash
npm run migrate
```

Start the development server (API + Vite with hot-reload):

```bash
npm run dev
```

- API: http://localhost:3000
- Client (Vite dev server): http://localhost:5173

### Production build (bare metal)

```bash
npm run build          # compiles api/ (tsc) and client/ (vite build)
npm start              # serves API; Express also serves the compiled client
```

## Quick start — Docker

### Prerequisites

- Docker and Docker Compose

### Setup

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD, OPENROUTER_API_KEY, and any other values
```

Build and start all services:

```bash
docker compose up --build
```

Run migrations on first start:

```bash
docker compose run api npm run migrate
```

Services:
- **client** (nginx): http://localhost:80 — serves the React SPA and proxies `/api` to the API service
- **api**: http://localhost:3000 — Express REST API
- **postgres**: PostgreSQL 16 on port 5432

Stop everything:

```bash
docker compose down
```

Destroy volumes (wipe database and uploads):

```bash
docker compose down -v
```

## Environment variables

Copy `.env.example` to `.env` and fill in the values. See `.env.example` for descriptions of every variable.

| Variable | Default | Required |
|---|---|---|
| `POSTGRES_USER` | `postgres` | Docker only |
| `POSTGRES_PASSWORD` | — | Docker only |
| `POSTGRES_DB` | `expenses_tracker` | Docker only |
| `DATABASE_URL` | — | Yes |
| `PORT` | `3000` | No |
| `UPLOAD_DIR` | `/app/uploads` | No |
| `NODE_ENV` | `development` | No |
| `CORS_ORIGIN` | — | Production only |
| `OPENROUTER_API_KEY` | — | Yes (AI features) |
| `OPENROUTER_MODEL` | `anthropic/claude-haiku-4-5` | No |

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start API + Vite dev server concurrently |
| `npm run build` | Compile API TypeScript + Vite production build |
| `npm start` | Run compiled API in production mode |
| `npm run migrate` | Apply pending database migrations |
| `npm test` | Run API (Jest) and client (Vitest) test suites |

## API

All endpoints are prefixed with `/api`.

| Resource | Endpoints |
|---|---|
| Categories | `GET/POST /api/categories`, `PUT/DELETE /api/categories/:id` |
| Movements | `GET/POST /api/movements`, `GET/PUT/DELETE /api/movements/:id` |
| Attachments | `POST /api/attachments`, `DELETE /api/attachments/:id` |
| Dashboard | `GET /api/dashboard?period=month&anchor=YYYY-MM-DD` |
| AI suggest | `POST /api/suggest/category` |
| OCR import | `POST /api/import/extract`, `POST /api/import/confirm` |
| Health | `GET /health` |
