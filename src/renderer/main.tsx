import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import type { DesktopAPI } from '../shared/types';
declare global { interface Window { desktop: DesktopAPI } }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
