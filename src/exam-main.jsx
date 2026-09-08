import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/supabaseBootstrap.js';
import ExamPage from './pages/ExamPage.jsx';
import { initializeTheme } from './lib/theme.js';
import { requestCameraStream } from './lib/proctoring/facemesh/cameraAccess.js';

initializeTheme();

let yoloRuntimePromise = null;
let faceMeshRuntimePromise = null;

function loadYoloRuntime() {
  if (!yoloRuntimePromise) {
    yoloRuntimePromise = import('./lib/proctoring/yolo/index.js')
      .then(runtime => {
        Object.assign(window.YoloProctor, {
          createMonitor: runtime.createYoloMonitor,
          createPolicy: runtime.createYoloObjectPolicy,
          normalizeConfig: runtime.normalizeObjectMonitoring,
          preloadModel: runtime.preloadYoloModel,
        });
        return window.YoloProctor;
      })
      .catch(error => {
        yoloRuntimePromise = null;
        throw error;
      });
  }
  return yoloRuntimePromise;
}

window.YoloProctor = {
  load: loadYoloRuntime,
  preloadModel: (...args) => loadYoloRuntime().then(runtime => runtime.preloadModel(...args)),
};

function loadFaceMeshRuntime() {
  if (!faceMeshRuntimePromise) {
    faceMeshRuntimePromise = import('./lib/proctoring/facemesh/index.js')
      .then(runtime => {
        Object.assign(window.FaceMeshProctor, {
          createRuntime: runtime.createFaceLandmarkerRuntime,
          createCalibration: runtime.createFaceCalibration,
          createRuleEngine: runtime.createFaceRuleEngine,
          createCorrelator: runtime.createFaceEventCorrelator,
          createAggregator: runtime.createFaceSessionAggregator,
          createEvaluationExporter: runtime.createEvaluationExporter,
          classifyObservation: runtime.classifyObservation,
          normalizeConfig: runtime.resolveFaceMonitoringConfig,
        });
        return window.FaceMeshProctor;
      })
      .catch(error => {
        faceMeshRuntimePromise = null;
        throw error;
      });
  }
  return faceMeshRuntimePromise;
}

window.FaceMeshProctor = {
  load: loadFaceMeshRuntime,
  requestCameraStream,
};

createRoot(document.getElementById('root')).render(<ExamPage />);
