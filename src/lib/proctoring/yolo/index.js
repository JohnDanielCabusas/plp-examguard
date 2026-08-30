import { preloadYoloModel, YoloMonitor } from './yoloRuntime.js';
import { YoloObjectPolicy, normalizeObjectMonitoring } from './objectPolicy.js';

export function createYoloMonitor(options) {
  return new YoloMonitor(options);
}

export function createYoloObjectPolicy(config) {
  return new YoloObjectPolicy(config);
}

export { preloadYoloModel };
export { normalizeObjectMonitoring };
