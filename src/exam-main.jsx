import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/supabaseBootstrap.js';
import ExamPage from './pages/ExamPage.jsx';
import { initializeTheme } from './lib/theme.js';

initializeTheme();

let yoloRuntimePromise = null;

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

createRoot(document.getElementById('root')).render(<ExamPage />);
