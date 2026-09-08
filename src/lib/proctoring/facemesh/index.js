import { FaceCalibrationSession } from './calibrationService.js';
import { FaceEventCorrelator } from './faceEventCorrelator.js';
import { FaceEvaluationExporter } from './evaluationExporter.js';
import { FaceLandmarkerRuntime } from './faceLandmarkerRuntime.js';
import { resolveFaceMonitoringConfig } from './faceMonitoringConfig.js';
import { FaceSessionAggregator } from './faceSessionAggregator.js';
import { classifyFaceObservation } from './headPoseEstimator.js';
import { FaceTemporalRuleEngine } from './temporalRuleEngine.js';

export function createFaceLandmarkerRuntime(options) {
  return new FaceLandmarkerRuntime(options);
}

export function createFaceCalibration(config = {}) {
  const resolved = resolveFaceMonitoringConfig(config);
  return new FaceCalibrationSession(resolved.calibration);
}

export function createFaceRuleEngine(config = {}, onEvent) {
  const resolved = resolveFaceMonitoringConfig(config);
  return new FaceTemporalRuleEngine(resolved.temporal, onEvent);
}

export function createFaceEventCorrelator(config = {}) {
  const resolved = resolveFaceMonitoringConfig(config);
  return new FaceEventCorrelator(resolved.correlation);
}

export function createFaceSessionAggregator() {
  return new FaceSessionAggregator();
}

export function createEvaluationExporter(options = {}) {
  return new FaceEvaluationExporter({ ...options, developmentMode: import.meta.env?.DEV === true });
}

export function classifyObservation(observation, baseline, config = {}) {
  return classifyFaceObservation(observation, baseline, resolveFaceMonitoringConfig(config));
}

export { resolveFaceMonitoringConfig };
