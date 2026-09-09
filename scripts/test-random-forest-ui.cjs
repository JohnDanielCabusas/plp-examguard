const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'public', 'js', 'admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'style.css'), 'utf8');
const statsStart = admin.indexOf('// STATISTICS (full page per exam)');
const reportsStart = admin.indexOf('// REPORTS', statsStart);
const statisticsBlock = admin.slice(statsStart, reportsStart);

assert.ok(statsStart >= 0 && reportsStart > statsStart, 'Statistics renderer must be present.');
assert.match(statisticsBlock, /Random Forest Risk Analysis/);
assert.match(statisticsBlock, />Students</);
assert.match(statisticsBlock, /Suspicious probability/);
assert.match(statisticsBlock, /Sessions analyzed/);
assert.match(statisticsBlock, /Needs Monitoring/);
assert.match(statisticsBlock, /Suspicious/);
assert.match(statisticsBlock, /aria-live="polite"/);
assert.match(statisticsBlock, /role="alert"/);
assert.match(statisticsBlock, /Not analyzed/);
assert.match(statisticsBlock, /do not prove misconduct/);
assert.doesNotMatch(statisticsBlock, /Average Probability/);
assert.doesNotMatch(statisticsBlock, /rf-distribution/);
assert.match(css, /\.rf-prediction-card/);
assert.match(css, /\.rf-student-row/);
assert.match(css, /\.rf-risk-badge/);
assert.match(css, /@media \(max-width: 520px\)/);

console.log('Random Forest per-student Statistics-card contract tests passed.');
