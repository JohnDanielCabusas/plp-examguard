# TUKLAS Random Forest

This directory contains the private training pipeline and server-side
prediction runtime for suspicious-behavior review. It does not make cheating
decisions, modify grades, or apply penalties.

## Setup and training

Use Python 3.11 and install the locked dependencies into the repository virtual
environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r ml\random_forest\requirements.txt
```

Place `tuklas_random_forest_training_ready.csv` in
`ml/random_forest/data/`. The data directory is ignored by Git and is never
copied into Vite's `public` or `dist` directories.

Train and evaluate offline:

```powershell
npm run train:random-forest
```

The command validates the exact schema, performs an 80/20 stratified split,
runs five-fold stratified cross-validation on the training portion, and writes:

- `artifacts/random_forest_model.joblib`
- `artifacts/random_forest_metadata.json`
- `artifacts/random_forest_metrics.json`

Training never occurs during a web request or application startup.

## Runtime

The Node server owns a long-lived Python JSON-lines worker. The worker loads the
model once, validates the exact feature set and order, and uses
`predict_proba()` with the suspicious-class index discovered from
`model.classes_`.

Optional environment variables:

```env
RF_PYTHON_PATH=C:\path\to\python.exe
RF_MODEL_PATH=C:\path\to\random_forest_model.joblib
RF_METADATA_PATH=C:\path\to\random_forest_metadata.json
```

Defaults point to the repository `.venv` and `ml/random_forest/artifacts`.

The production host must support a persistent Node process that can start a
Python child process. For a serverless/static-only deployment, move this same
validated predictor behind a private Python service instead of attempting to
run the worker in the browser.

Risk levels are `normal` below 0.50, `needs_monitoring` from 0.50 through 0.79,
and `suspicious` from 0.80. Every value is statistical review support, not
proof of academic dishonesty.

## Tests

```powershell
npm run test:random-forest
npm run test:random-forest:browser
npm run test:random-forest:database
npm run test:facemesh
npm run test:facemesh:browser
npm run build
```

Apply the idempotent database migration with the repository's normal Supabase
environment variables:

```powershell
$env:DOTENV_CONFIG_PATH='.env.local'
node -r dotenv/config scripts/apply-supabase-sql.mjs supabase/random-forest-predictions-migration.sql
```

## Current limitation

The provided CSV has no anonymized student or session grouping identifier.
Its metrics are a prototype row-level baseline. Before institutional use,
collect consent-based TUKLAS pilot data, keep all records from one student or
session in a single split, repeat grouped evaluation, and calibrate the two
review thresholds with professors.
