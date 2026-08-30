import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as ort from 'onnxruntime-web';

const manifestPath = resolve(process.argv[2] || 'public/models/yolo-proctor-v1.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const mappings = manifest.policyMappings || {};
const classNames = Array.isArray(manifest.classNames) ? manifest.classNames : [];
const requiredPolicies = manifest.detectorRole === 'phone-specialist'
  ? new Set(['mobile_phone'])
  : new Set(['mobile_phone', 'laptop_monitor', 'book_textbook']);

assert.ok(classNames.length > 0, 'YOLO manifest must include model class names.');
assert.equal(
  Object.hasOwn(mappings, 'person'),
  false,
  'Person is a context class and must not map directly to a violation.',
);
for (const rawClass of Object.keys(mappings)) {
  assert.ok(classNames.includes(rawClass), `Mapped class is absent from model: ${rawClass}`);
}
for (const policyClass of requiredPolicies) {
  assert.ok(
    Object.values(mappings).includes(policyClass),
    `YOLO manifest is missing policy class: ${policyClass}`,
  );
}
for (const [index, region] of (manifest.scanRegions || []).entries()) {
  const { x, y, width, height } = region;
  assert.ok([x, y, width, height].every(Number.isFinite), `Scan region ${index} must be numeric.`);
  assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0, `Scan region ${index} must be positive.`);
  assert.ok(x + width <= 1 && y + height <= 1, `Scan region ${index} must stay inside the frame.`);
}

const modelName = String(manifest.modelUrl || '').split(/[?#]/, 1)[0].replace(/^\/models\//, '');
assert.equal(modelName, modelName.split('/').pop(), 'YOLO model must be directly under public/models.');
const modelPath = resolve('public/models', modelName);
const model = await readFile(modelPath);
const checksum = createHash('sha256').update(model).digest('hex');
assert.equal(checksum, manifest.sha256, 'YOLO model checksum does not match the manifest.');

const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
assert.equal(session.inputNames.length, 1);
assert.equal(session.outputNames.length, 1);

const inputSize = Number(manifest.inputSize || 640);
const input = new ort.Tensor('float32', new Float32Array(3 * inputSize * inputSize), [1, 3, inputSize, inputSize]);
const outputMap = await session.run({ [session.inputNames[0]]: input });
const output = outputMap[session.outputNames[0]];
const channelFirst = output.dims[1] === classNames.length + 4;
const endToEnd = output.dims[2] === 6;
assert.equal(output.dims.length, 3);
assert.equal(output.dims[0], 1);
assert.ok(channelFirst || endToEnd, `Unexpected YOLO output shape: [${output.dims.join(', ')}].`);
assert.ok(output.data.length > 0);

console.log(`YOLO model smoke test passed: ${manifest.version} -> [${output.dims.join(', ')}].`);
