let ort = null;
let session = null;
let manifest = null;
let backend = '';
let canvas = null;
let context = null;
let sourceCanvas = null;
let sourceContext = null;
let verificationCanvas = null;
let verificationContext = null;
let scanRegionIndex = 0;

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = (a.width * a.height) + (b.width * b.height) - intersection;
  return union > 0 ? intersection / union : 0;
}

function nonMaximumSuppression(detections, threshold, limit) {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  while (sorted.length && kept.length < limit) {
    const current = sorted.shift();
    kept.push(current);
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].rawClass !== current.rawClass) continue;
      if (intersectionOverUnion(sorted[i].boundingBox, current.boundingBox) >= threshold) {
        sorted.splice(i, 1);
      }
    }
  }
  return kept;
}

function tensorFromContext(targetContext, inputSize) {
  const pixels = targetContext.getImageData(0, 0, inputSize, inputSize).data;
  const planeSize = inputSize * inputSize;
  const input = new Float32Array(planeSize * 3);
  for (let pixelIndex = 0; pixelIndex < planeSize; pixelIndex += 1) {
    const sourceIndex = pixelIndex * 4;
    input[pixelIndex] = pixels[sourceIndex] / 255;
    input[planeSize + pixelIndex] = pixels[sourceIndex + 1] / 255;
    input[(planeSize * 2) + pixelIndex] = pixels[sourceIndex + 2] / 255;
  }
  return new ort.Tensor('float32', input, [1, 3, inputSize, inputSize]);
}

function normalizedScanRegion(region, sourceWidth, sourceHeight) {
  if (!region || typeof region !== 'object') {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }
  const normalizedX = Math.max(0, Math.min(0.95, Number(region.x || 0)));
  const normalizedY = Math.max(0, Math.min(0.95, Number(region.y || 0)));
  const normalizedWidth = Math.max(0.05, Math.min(1 - normalizedX, Number(region.width || 1)));
  const normalizedHeight = Math.max(0.05, Math.min(1 - normalizedY, Number(region.height || 1)));
  const x = Math.floor(normalizedX * sourceWidth);
  const y = Math.floor(normalizedY * sourceHeight);
  const right = Math.min(sourceWidth, Math.ceil((normalizedX + normalizedWidth) * sourceWidth));
  const bottom = Math.min(sourceHeight, Math.ceil((normalizedY + normalizedHeight) * sourceHeight));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function prepareInput(bitmap, scanRegion = null) {
  const inputSize = Number(manifest.inputSize || 640);
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  sourceCanvas ||= new OffscreenCanvas(sourceWidth, sourceHeight);
  if (sourceCanvas.width !== sourceWidth || sourceCanvas.height !== sourceHeight) {
    sourceCanvas.width = sourceWidth;
    sourceCanvas.height = sourceHeight;
  }
  sourceContext ||= sourceCanvas.getContext('2d', { willReadFrequently: true });
  sourceContext.drawImage(bitmap, 0, 0, sourceWidth, sourceHeight);
  bitmap.close?.();

  const region = normalizedScanRegion(scanRegion, sourceWidth, sourceHeight);

  canvas ||= new OffscreenCanvas(inputSize, inputSize);
  if (canvas.width !== inputSize || canvas.height !== inputSize) {
    canvas.width = inputSize;
    canvas.height = inputSize;
  }
  context ||= canvas.getContext('2d', { willReadFrequently: true });

  const scale = Math.min(inputSize / region.width, inputSize / region.height);
  const drawWidth = Math.round(region.width * scale);
  const drawHeight = Math.round(region.height * scale);
  const padX = Math.floor((inputSize - drawWidth) / 2);
  const padY = Math.floor((inputSize - drawHeight) / 2);

  context.fillStyle = 'rgb(114, 114, 114)';
  context.fillRect(0, 0, inputSize, inputSize);
  context.drawImage(
    sourceCanvas,
    region.x,
    region.y,
    region.width,
    region.height,
    padX,
    padY,
    drawWidth,
    drawHeight,
  );

  return {
    tensor: tensorFromContext(context, inputSize),
    inputSize,
    sourceWidth,
    sourceHeight,
    regionX: region.x,
    regionY: region.y,
    regionWidth: region.width,
    regionHeight: region.height,
    scale,
    padX,
    padY,
  };
}

function prepareVerificationInput(boundingBox, transform, options = {}) {
  const { mirrored = false, padding: paddingOverride } = options;
  const inputSize = transform.inputSize;
  verificationCanvas ||= new OffscreenCanvas(inputSize, inputSize);
  if (verificationCanvas.width !== inputSize || verificationCanvas.height !== inputSize) {
    verificationCanvas.width = inputSize;
    verificationCanvas.height = inputSize;
  }
  verificationContext ||= verificationCanvas.getContext('2d', { willReadFrequently: true });

  const configuredPadding = Number(manifest.verificationPadding ?? 0.18);
  const padding = Math.max(0, Number.isFinite(paddingOverride) ? paddingOverride : configuredPadding);
  const expandedX = Math.max(0, boundingBox.x - (boundingBox.width * padding));
  const expandedY = Math.max(0, boundingBox.y - (boundingBox.height * padding));
  const expandedRight = Math.min(transform.sourceWidth, boundingBox.x + boundingBox.width * (1 + padding));
  const expandedBottom = Math.min(transform.sourceHeight, boundingBox.y + boundingBox.height * (1 + padding));
  const cropX = expandedX;
  const cropY = expandedY;
  const cropWidth = Math.max(1, expandedRight - expandedX);
  const cropHeight = Math.max(1, expandedBottom - expandedY);
  const cropScale = Math.min(inputSize / cropWidth, inputSize / cropHeight);
  const drawWidth = Math.round(cropWidth * cropScale);
  const drawHeight = Math.round(cropHeight * cropScale);
  const drawX = Math.floor((inputSize - drawWidth) / 2);
  const drawY = Math.floor((inputSize - drawHeight) / 2);

  verificationContext.fillStyle = 'rgb(114, 114, 114)';
  verificationContext.fillRect(0, 0, inputSize, inputSize);
  verificationContext.save();
  if (mirrored) {
    verificationContext.translate(inputSize, 0);
    verificationContext.scale(-1, 1);
  }
  verificationContext.drawImage(
    sourceCanvas,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    drawX,
    drawY,
    drawWidth,
    drawHeight,
  );
  verificationContext.restore();
  return tensorFromContext(verificationContext, inputSize);
}

function mapBoundingBox(x1, y1, x2, y2, transform) {
  const regionRight = transform.regionX + transform.regionWidth;
  const regionBottom = transform.regionY + transform.regionHeight;
  const left = Math.max(transform.regionX, Math.min(
    regionRight,
    transform.regionX + ((x1 - transform.padX) / transform.scale),
  ));
  const top = Math.max(transform.regionY, Math.min(
    regionBottom,
    transform.regionY + ((y1 - transform.padY) / transform.scale),
  ));
  const right = Math.max(transform.regionX, Math.min(
    regionRight,
    transform.regionX + ((x2 - transform.padX) / transform.scale),
  ));
  const bottom = Math.max(transform.regionY, Math.min(
    regionBottom,
    transform.regionY + ((y2 - transform.padY) / transform.scale),
  ));
  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(Math.max(0, right - left)),
    height: Math.round(Math.max(0, bottom - top)),
    frameWidth: transform.sourceWidth,
    frameHeight: transform.sourceHeight,
  };
}

function getPolicyClass(rawClass) {
  return manifest.policyMappings?.[rawClass] || '';
}

function getContextClass(rawClass) {
  return rawClass === 'person' ? 'person' : '';
}

function getConfidenceThreshold(rawClass, objectClass) {
  return Number(
    manifest.confidenceThresholds?.[objectClass]
    ?? manifest.confidenceThresholds?.[rawClass]
    ?? manifest.defaultConfidence
    ?? 0.55,
  );
}

function getContextConfidenceThreshold(contextClass) {
  return Number(manifest.contextConfidenceThresholds?.[contextClass] ?? 0.25);
}

function parseChannelFirstOutput(output, transform) {
  const dimensions = output.dims || [];
  const channels = Number(dimensions[1] || 0);
  const anchors = Number(dimensions[2] || 0);
  const classCount = channels - 4;
  if (classCount <= 0 || anchors <= 0) return [];

  const detections = [];
  for (let anchor = 0; anchor < anchors; anchor += 1) {
    let bestScore = 0;
    let bestClassIndex = -1;
    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
      const score = output.data[((classIndex + 4) * anchors) + anchor];
      if (score > bestScore) {
        bestScore = score;
        bestClassIndex = classIndex;
      }
    }

    const rawClass = manifest.classNames?.[bestClassIndex] || String(bestClassIndex);
    const objectClass = getPolicyClass(rawClass);
    const contextClass = getContextClass(rawClass);
    if (!objectClass && !contextClass) continue;
    const threshold = objectClass
      ? getConfidenceThreshold(rawClass, objectClass)
      : getContextConfidenceThreshold(contextClass);
    if (bestScore < threshold) continue;

    const centerX = output.data[anchor];
    const centerY = output.data[anchors + anchor];
    const width = output.data[(anchors * 2) + anchor];
    const height = output.data[(anchors * 3) + anchor];
    const boundingBox = mapBoundingBox(
      centerX - (width / 2),
      centerY - (height / 2),
      centerX + (width / 2),
      centerY + (height / 2),
      transform,
    );
    if (boundingBox.width < 4 || boundingBox.height < 4) continue;
    detections.push({ rawClass, objectClass, contextClass, confidence: bestScore, boundingBox });
  }
  return detections;
}

function parseEndToEndOutput(output, transform) {
  const dimensions = output.dims || [];
  const rows = Number(dimensions[1] || 0);
  const stride = Number(dimensions[2] || 0);
  if (stride !== 6) return [];

  const detections = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = row * stride;
    const confidence = Number(output.data[offset + 4] || 0);
    const classIndex = Math.round(Number(output.data[offset + 5] || 0));
    const rawClass = manifest.classNames?.[classIndex] || String(classIndex);
    const objectClass = getPolicyClass(rawClass);
    const contextClass = getContextClass(rawClass);
    if (!objectClass && !contextClass) continue;
    const threshold = objectClass
      ? getConfidenceThreshold(rawClass, objectClass)
      : getContextConfidenceThreshold(contextClass);
    if (confidence < threshold) continue;
    const boundingBox = mapBoundingBox(
      output.data[offset],
      output.data[offset + 1],
      output.data[offset + 2],
      output.data[offset + 3],
      transform,
    );
    if (boundingBox.width < 4 || boundingBox.height < 4) continue;
    detections.push({ rawClass, objectClass, contextClass, confidence, boundingBox });
  }
  return detections;
}

function parseOutput(output, transform) {
  const dimensions = output.dims || [];
  const detections = dimensions.length === 3 && dimensions[2] === 6
    ? parseEndToEndOutput(output, transform)
    : parseChannelFirstOutput(output, transform);
  return nonMaximumSuppression(
    detections,
    Number(manifest.nmsThreshold || 0.45),
    Number(manifest.maxDetections || 20),
  );
}

function getPolicyScores(output) {
  const dimensions = output.dims || [];
  const scores = {};
  if (dimensions.length !== 3) return scores;

  if (Number(dimensions[2] || 0) === 6) {
    const rows = Number(dimensions[1] || 0);
    for (let row = 0; row < rows; row += 1) {
      const offset = row * 6;
      const classIndex = Math.round(Number(output.data[offset + 5] || 0));
      const objectClass = getPolicyClass(manifest.classNames?.[classIndex] || String(classIndex));
      if (!objectClass) continue;
      scores[objectClass] = Math.max(Number(scores[objectClass] || 0), Number(output.data[offset + 4] || 0));
    }
    return scores;
  }

  const channels = Number(dimensions[1] || 0);
  const anchors = Number(dimensions[2] || 0);
  const classCount = channels - 4;
  for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
    const objectClass = getPolicyClass(manifest.classNames?.[classIndex] || String(classIndex));
    if (!objectClass) continue;
    let bestScore = Number(scores[objectClass] || 0);
    const offset = (classIndex + 4) * anchors;
    for (let anchor = 0; anchor < anchors; anchor += 1) {
      bestScore = Math.max(bestScore, Number(output.data[offset + anchor] || 0));
    }
    scores[objectClass] = bestScore;
  }
  return scores;
}

function humanContextForDetection(detection, contextDetections) {
  const contextAvailable = Array.isArray(manifest.classNames) && manifest.classNames.includes('person');
  const people = contextDetections.filter(candidate => candidate.contextClass === 'person');
  const box = detection.boundingBox;
  if (!box) {
    return {
      available: contextAvailable,
      personDetected: people.length > 0,
      nearPerson: false,
      overlapRatio: 0,
      proximityRatio: null,
    };
  }

  const boxArea = Math.max(1, box.width * box.height);
  const centerX = box.x + (box.width / 2);
  const centerY = box.y + (box.height / 2);
  let overlapRatio = 0;
  let proximityRatio = Infinity;
  people.forEach(person => {
    const personBox = person.boundingBox;
    if (!personBox) return;
    const left = Math.max(box.x, personBox.x);
    const top = Math.max(box.y, personBox.y);
    const right = Math.min(box.x + box.width, personBox.x + personBox.width);
    const bottom = Math.min(box.y + box.height, personBox.y + personBox.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    overlapRatio = Math.max(overlapRatio, intersection / boxArea);

    const gapX = Math.max(personBox.x - centerX, 0, centerX - (personBox.x + personBox.width));
    const gapY = Math.max(personBox.y - centerY, 0, centerY - (personBox.y + personBox.height));
    const personScale = Math.max(1, personBox.width, personBox.height);
    proximityRatio = Math.min(proximityRatio, Math.hypot(gapX, gapY) / personScale);
  });

  return {
    available: contextAvailable,
    personDetected: people.length > 0,
    nearPerson: overlapRatio >= 0.15 || proximityRatio <= 0.08,
    overlapRatio,
    proximityRatio: Number.isFinite(proximityRatio) ? proximityRatio : null,
  };
}

async function verifyDetections(detections, transform) {
  const contextDetections = detections.filter(detection => detection.contextClass);
  const candidateCounts = new Map();
  const candidates = [...detections]
    .filter(detection => detection.objectClass)
    .sort((a, b) => b.confidence - a.confidence)
    .filter(detection => {
      const count = candidateCounts.get(detection.objectClass) || 0;
      const limit = Math.max(1, Number(
        manifest.verificationCandidateLimits?.[detection.objectClass] ?? 1,
      ));
      if (count >= limit) return false;
      candidateCounts.set(detection.objectClass, count + 1);
      return true;
    });

  const verified = [];
  for (const detection of candidates) {
    const inputName = session.inputNames[0];
    const runVerification = async (options = {}) => {
      const tensor = prepareVerificationInput(detection.boundingBox, transform, options);
      const result = await session.run({ [inputName]: tensor });
      return getPolicyScores(result[session.outputNames[0]]);
    };
    const scores = await runVerification();
    const threshold = Number(
      manifest.verificationThresholds?.[detection.objectClass]
      ?? manifest.confidenceThresholds?.[detection.objectClass]
      ?? manifest.defaultConfidence
      ?? 0.55,
    );
    const supportsTightRetry = ['mobile_phone', 'book_textbook'].includes(detection.objectClass);
    if (
      detection.objectClass === 'mobile_phone'
      && Number(scores[detection.objectClass] || 0) < threshold
    ) {
      // A detector box around a partly hidden phone often covers only the
      // visible edge. Re-check with substantially more hand/background context
      // before trying the existing tight and mirrored crops.
      const wideScores = await runVerification({
        padding: Number(manifest.partialVisibilityPadding ?? 0.42),
      });
      Object.entries(wideScores).forEach(([objectClass, score]) => {
        scores[objectClass] = Math.max(Number(scores[objectClass] || 0), Number(score || 0));
      });
    }
    if (supportsTightRetry && Number(scores[detection.objectClass] || 0) < threshold) {
      // A tighter crop gives phone backs, cases, and angled books more pixels.
      const tightScores = await runVerification({ padding: 0.06 });
      Object.entries(tightScores).forEach(([objectClass, score]) => {
        scores[objectClass] = Math.max(Number(scores[objectClass] || 0), Number(score || 0));
      });
    }
    if (supportsTightRetry && Number(scores[detection.objectClass] || 0) < threshold) {
      const mirroredScores = await runVerification({ mirrored: true, padding: 0.06 });
      Object.entries(mirroredScores).forEach(([objectClass, score]) => {
        scores[objectClass] = Math.max(Number(scores[objectClass] || 0), Number(score || 0));
      });
    }
    const verificationConfidence = Number(scores[detection.objectClass] || 0);
    const competingConfidence = Math.max(
      0,
      ...Object.entries(scores)
        .filter(([objectClass]) => objectClass !== detection.objectClass)
        .map(([, score]) => Number(score || 0)),
    );
    const margin = Number(manifest.verificationMargin || 0);
    if (verificationConfidence < threshold || verificationConfidence < competingConfidence + margin) continue;
    verified.push({
      ...detection,
      fullFrameConfidence: detection.confidence,
      confidence: verificationConfidence,
      verified: true,
      verificationConfidence,
      humanContext: humanContextForDetection(detection, contextDetections),
    });
  }
  return verified;
}

async function initialize(payload) {
  manifest = payload.manifest;
  const modelSource = payload.modelBuffer || manifest.modelUrl;
  const commonOptions = { graphOptimizationLevel: 'all' };

  // Avoid downloading the substantially larger WebGPU runtime on browsers
  // that cannot use it. If WebGPU initialization fails, load the smaller WASM
  // runtime as a separate fallback rather than paying for both up front.
  if (self.navigator?.gpu) {
    try {
      ort = await import('onnxruntime-web/webgpu');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      session = await ort.InferenceSession.create(modelSource, {
        ...commonOptions,
        executionProviders: ['webgpu'],
      });
      backend = 'webgpu';
    } catch (webGpuError) {
      session = null;
    }
  }

  if (!session) {
    ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    session = await ort.InferenceSession.create(modelSource, {
      ...commonOptions,
      executionProviders: ['wasm'],
    });
    backend = 'wasm';
  }

  self.postMessage({
    type: 'ready',
    backend,
    modelVersion: manifest.version || '',
    modelProfile: manifest.modelProfile || '',
    detectorRole: manifest.detectorRole || 'primary',
  });
}

async function infer(payload) {
  if (!session || !payload.bitmap) return;
  const startedAt = performance.now();
  const configuredRegions = Array.isArray(manifest.scanRegions) ? manifest.scanRegions : [];
  const scanRegion = configuredRegions.length
    ? configuredRegions[scanRegionIndex++ % configuredRegions.length]
    : null;
  const transform = prepareInput(payload.bitmap, scanRegion);
  const inputName = session.inputNames[0];
  const result = await session.run({ [inputName]: transform.tensor });
  const output = result[session.outputNames[0]];
  const detections = await verifyDetections(parseOutput(output, transform), transform);
  self.postMessage({
    type: 'result',
    requestId: payload.requestId,
    detections,
    backend,
    modelVersion: manifest.version || '',
    modelProfile: manifest.modelProfile || '',
    detectorRole: manifest.detectorRole || 'primary',
    inferenceMs: Math.round(performance.now() - startedAt),
  });
}

self.addEventListener('message', async (event) => {
  const payload = event.data || {};
  try {
    if (payload.type === 'init') await initialize(payload);
    if (payload.type === 'infer') await infer(payload);
  } catch (error) {
    payload.bitmap?.close?.();
    self.postMessage({
      type: payload.type === 'init' ? 'init-error' : 'inference-error',
      requestId: payload.requestId,
      message: error?.message || String(error),
    });
  }
});
