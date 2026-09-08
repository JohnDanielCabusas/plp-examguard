import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourceRoot = resolve('node_modules/@mediapipe/tasks-vision/wasm');
const destinationRoot = resolve('public/vendor/mediapipe/wasm');
const files = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

await mkdir(destinationRoot, { recursive: true });
await Promise.all(files.map(file => copyFile(resolve(sourceRoot, file), resolve(destinationRoot, file))));
console.log(`Copied ${files.length} MediaPipe WASM assets to public/vendor/mediapipe/wasm.`);
