# Deploying TUKLAS to Railway

Written for whoever is putting this system online — assumes you can use a
terminal and the Railway dashboard, but not that you know this codebase.

## Why a Dockerfile and not Railway's autodetect

TUKLAS runs two runtimes in one process tree. Node serves the app and the API;
Python answers Random Forest predictions through a worker that
`server/random-forest-worker.cjs` spawns and keeps alive. Railway's Node
autodetection would give you Node alone, and every suspicion-probability request
would fail. The `Dockerfile` installs both.

The live Monitoring screen also needs WebSockets (`server/monitor-websocket.cjs`
upgrades the same HTTP server). Railway supports these; most shared hosting does
not, which is why shared plans are not an option for this app.

## One-time setup

### 1. Create the service

1. Railway → **New Project** → **Deploy from GitHub repo**
2. Pick `plp-examguard`, branch `prod1`
3. Railway reads `railway.json`, sees `"builder": "DOCKERFILE"` and uses the
   `Dockerfile` at the repo root. No build command to configure.

### 2. Set the environment variables

Service → **Variables**. Copy the values from your local `.env.local`.

**Compiled into the browser bundle at build time** — Railway passes these to the
Docker build, and the `Dockerfile` declares matching `ARG`s. If either is
missing or wrong at build time, the deployed app loads but cannot reach
Supabase, and rebuilding is the only fix:

| Variable | Notes |
| --- | --- |
| `VITE_SUPABASE_URL` | Your Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The publishable (anon) key — safe in a browser bundle |

**Read by the server at runtime:**

| Variable | Notes |
| --- | --- |
| `SUPABASE_DB_HOST` | |
| `SUPABASE_DB_PORT` | |
| `SUPABASE_DB_NAME` | |
| `SUPABASE_DB_USER` | |
| `SUPABASE_DB_PASSWORD` | Secret — never commit it |
| `SUPABASE_DB_SSL` | |
| `SMTP_HOST` | |
| `SMTP_PORT` | |
| `SMTP_SECURE` | |
| `SMTP_USER` | |
| `SMTP_PASS` | Secret |
| `SMTP_FROM_EMAIL` | |
| `SMTP_FALLBACK_MODE` | |

Do **not** set `PORT` or `HOST`. Railway injects `PORT` and the app already
binds `0.0.0.0`.

`RF_PYTHON_PATH` is set inside the image and should not be overridden.

### 3. Apply the database schema

The app expects columns that may not exist yet on a fresh or older Supabase
project. From your machine, with `.env.local` populated:

```bash
npm run supabase:schema
```

Adding a field without its column fails silently — the write looks like it
succeeded and the value never leaves the browser. If something saves in the
professor panel but never reaches students, this is the first thing to check.

### 4. Generate a public URL

Service → **Settings** → **Networking** → **Generate Domain**. Railway routes
to whatever port it injected; nothing to configure on our side.

## Deploying after that

Push to `prod1`. Railway rebuilds and redeploys automatically.

## Checking a deploy worked

Against your Railway URL:

```bash
curl -o /dev/null -w "%{http_code}\n" https://YOUR-APP.up.railway.app/
curl -o /dev/null -w "%{http_code}\n" https://YOUR-APP.up.railway.app/admin
curl -o /dev/null -w "%{http_code}\n" https://YOUR-APP.up.railway.app/exam

# Should return JSON naming the professor account, which proves the API and
# the database connection are both live:
curl -X POST -H "Content-Type: application/json" \
  -d '{"identifier":"admin"}' \
  https://YOUR-APP.up.railway.app/api/auth/professor/continue
```

Then open the professor panel, pick an exam with submissions, and load
**Statistics**. If the Suspicion Probability card fills in, the Python worker
started correctly — that is the part most likely to break in a new environment.

## Things that will bite you

**First load is heavy.** Each student downloads roughly 25–35 MB before an exam
starts: MediaPipe WASM, a YOLO model, and the face and hand landmarkers. It is
cached afterwards, but for a 40-student sitting the first few minutes pull well
over a gigabyte. Have students open the exam page a few minutes early rather
than all at once on the hour.

**The build is slow the first time.** Installing scikit-learn, pandas and numpy,
plus a Vite build that emits ~139 MB of assets, takes several minutes. Later
builds reuse the cached dependency layers and are much quicker.

**Supabase free tier is 500 MB.** Camera evidence is stored in the session rows:
one live snapshot plus up to eight violation snapshots per student, about
700 KB per student per exam. That is roughly 28 MB for a 40-student sitting, so
somewhere around 15–20 exams before the free tier fills. When it starts to
pinch, move snapshots to Supabase Storage instead of base64 in the row.

**Memory.** Railway's smallest instances are tight, and the Python worker holds
the model in memory alongside Node. If deploys die during an exam, raise the
memory limit before looking anywhere else.

## Local equivalent

To run exactly what Railway runs:

```bash
npm run build
PORT=8080 HOST=0.0.0.0 NODE_ENV=production node server.js
```
