import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { StartupDiscoveryPage } from './pages/StartupDiscoveryPage';
import './globals.css';

// Standalone development mode
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<StartupDiscoveryPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
