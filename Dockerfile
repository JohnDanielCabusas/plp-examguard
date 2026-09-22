# TUKLAS runs two runtimes in one container: Node serves the app and the API,
# and Python answers Random Forest predictions through a worker that server/
# random-forest-worker.cjs spawns and keeps alive. That pairing is the reason
# shared hosting cannot run this app and why we build an image rather than
# letting the platform guess.
FROM node:24-trixie-slim

# Debian 13 ships Python 3.13, which is the version the Random Forest artifacts
# in ml/random_forest/artifacts were trained and pickled under. joblib files are
# sensitive to the interpreter they came from, so matching it here avoids a
# model that loads fine locally and fails to unpickle in production. If this
# base image ever moves off 3.13, retrain the artifacts or pin the interpreter.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# A virtualenv keeps the prediction worker's packages away from Debian's own
# Python, and pointing RF_PYTHON_PATH at it beats the interpreter lookup in
# random-forest-worker.cjs, which would otherwise hunt for a local .venv.
ENV RF_PYTHON_PATH=/opt/venv/bin/python
RUN python3 -m venv /opt/venv

WORKDIR /app

# Python requirements first: they change far less often than application code,
# so this layer stays cached across most deploys.
COPY ml/random_forest/requirements.txt ./ml/random_forest/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/venv/bin/pip install --no-cache-dir -r ml/random_forest/requirements.txt

# Node dependencies next, for the same reason. playwright-core is the only
# devDependency and is needed by nothing at runtime; vite and the React plugin
# live in dependencies, so the build below still has what it needs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The Supabase URL and publishable key are read through import.meta.env, which
# Vite substitutes at BUILD time — they are compiled into the browser bundle,
# not read from the environment when the server starts. Railway passes service
# variables to Docker builds as build arguments, so they have to be declared
# here or the built app ships with no Supabase connection at all.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_PUBLISHABLE_KEY
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_PUBLISHABLE_KEY=$VITE_SUPABASE_PUBLISHABLE_KEY

# Copies the MediaPipe assets into public/vendor, then builds into dist/, which
# is what server.js serves.
RUN npm run build

ENV NODE_ENV=production
# server.js defaults to 0.0.0.0 already; stated here so it survives any change
# to that default. Railway injects PORT and routes to it.
ENV HOST=0.0.0.0

CMD ["node", "server.js"]
