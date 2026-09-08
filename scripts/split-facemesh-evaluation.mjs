import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [, , inputPath, outputPath = 'facemesh-evaluation-splits'] = process.argv;
if (!inputPath) throw new Error('Usage: node scripts/split-facemesh-evaluation.mjs <input.csv> [output-directory]');

const text = await readFile(resolve(inputPath), 'utf8');
const lines = text.trim().split(/\r?\n/);
const header = lines.shift();
if (!header) throw new Error('CSV is empty.');
const columns = header.split(',');
const participantIndex = columns.indexOf('participant_id');
if (participantIndex < 0) throw new Error('CSV must contain participant_id.');

const byParticipant = new Map();
for (const line of lines) {
  const participantId = line.split(',')[participantIndex];
  if (!participantId) continue;
  const rows = byParticipant.get(participantId) || [];
  rows.push(line);
  byParticipant.set(participantId, rows);
}

// A stable hash makes reruns reproducible and keeps every participant in one split.
function hash(value) {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

const splits = { development: [], validation: [], test: [] };
for (const [participantId, rows] of byParticipant) {
  const bucket = hash(participantId) % 100;
  const name = bucket < 70 ? 'development' : bucket < 85 ? 'validation' : 'test';
  splits[name].push(...rows);
}

const destination = resolve(outputPath);
await mkdir(destination, { recursive: true });
await Promise.all(Object.entries(splits).map(([name, rows]) => (
  writeFile(resolve(destination, `${name}.csv`), `${header}\n${rows.join('\n')}${rows.length ? '\n' : ''}`)
)));
console.log(`Wrote participant-isolated 70/15/15 splits for ${byParticipant.size} participants to ${destination}.`);
