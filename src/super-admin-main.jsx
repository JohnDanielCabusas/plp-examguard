import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/supabaseBootstrap.js';
import SuperAdminPage from './pages/SuperAdminPage.jsx';
import { initializeTheme } from './lib/theme.js';

initializeTheme();

createRoot(document.getElementById('root')).render(<SuperAdminPage />);
