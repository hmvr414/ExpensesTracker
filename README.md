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
| `GOOGLE_CLIENT_ID` | — | Gmail import only |
| `GOOGLE_CLIENT_SECRET` | — | Gmail import only |
| `GOOGLE_REDIRECT_URI` | — | Gmail import only |

## Gmail integration setup

The Gmail import feature reads bank notification emails through the Gmail API
(read-only). It needs a Google OAuth client, configured once in the
[Google Cloud Console](https://console.cloud.google.com):

1. **Create a project** (or pick an existing one).
2. **Enable the Gmail API**: APIs & Services → Library → search "Gmail API" → Enable.
3. **Configure the OAuth consent screen**: APIs & Services → OAuth consent screen →
   User type "External" → fill in the app name and your email. Add the scope
   `https://www.googleapis.com/auth/gmail.readonly`.
4. **Create an OAuth client ID**: APIs & Services → Credentials → Create credentials →
   OAuth client ID → Application type "Web application". Add the redirect URI —
   for local development: `http://localhost:3000/api/gmail/oauth/callback`.
5. **Copy the credentials to `.env`**: the client ID → `GOOGLE_CLIENT_ID`, the
   client secret → `GOOGLE_CLIENT_SECRET`, and the redirect URI from step 4 →
   `GOOGLE_REDIRECT_URI`.

> ⚠️ **Publish the consent screen to "In production".** While the consent screen
> is in "Testing" status, Google expires refresh tokens after **7 days**, which
> forces you to reconnect Gmail every week. On the OAuth consent screen page,
> click "Publish app". You do not need Google's verification for personal use —
> when connecting, click "Advanced" → "Go to <app> (unsafe)" once on the
> unverified-app warning.

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
| Gmail | `GET /api/gmail/auth-url`, `GET /api/gmail/oauth/callback`, `GET /api/gmail/status`, `DELETE /api/gmail/connection` |
| Health | `GET /health` |
