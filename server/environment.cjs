function optionalEnvironmentValue(name, environment = process.env) {
  const value = String(environment?.[name] ?? '').trim();
  return value && !/^(undefined|null)$/i.test(value) ? value : '';
}

// The values this project's own env files set, without anything inherited from
// the machine. Vite's loadEnv lets an existing process variable beat the file,
// so a stale SUPABASE_DB_* left in the Windows user environment silently pointed
// the dev server's API at a different database from the one the browser used.
// Files are read in Vite's order, later ones winning. Deployments have no env
// files, so there this returns nothing and the platform's variables are used.
function readEnvFiles(mode, directory = process.cwd()) {
  const fs = require('fs');
  const path = require('path');
  const dotenv = require('dotenv');
  const files = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  const values = {};
  for (const file of files) {
    const filePath = path.join(directory, file);
    if (!fs.existsSync(filePath)) continue;
    Object.assign(values, dotenv.parse(fs.readFileSync(filePath)));
  }
  return values;
}

function forwardEnvironment(source, names, target = process.env) {
  for (const name of names) {
    const candidate = source?.[name] || target?.[name];
    const normalized = String(candidate ?? '').trim();
    if (normalized && !/^(undefined|null)$/i.test(normalized)) {
      target[name] = candidate;
    } else {
      delete target[name];
    }
  }
}

module.exports = {
  forwardEnvironment,
  optionalEnvironmentValue,
  readEnvFiles,
};
