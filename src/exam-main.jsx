import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/supabaseBootstrap.js';
import ExamPage from './pages/ExamPage.jsx';
import { initializeTheme } from './lib/theme.js';

initializeTheme();

createRoot(document.getElementById('root')).render(<ExamPage />);
