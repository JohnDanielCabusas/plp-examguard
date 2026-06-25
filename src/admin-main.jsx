import React from 'react';
import { createRoot } from 'react-dom/client';
import './lib/supabaseBootstrap.js';
import AdminPage from './pages/AdminPage.jsx';

createRoot(document.getElementById('root')).render(<AdminPage />);
