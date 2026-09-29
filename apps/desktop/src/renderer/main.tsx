import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme } from './themes';
import { readCachedTheme } from './theme-preferences';
import { applyTypography, readCachedTypography } from './typography';
import './themes.css';
import './style.css';
import './inspector.css';
import './settings.css';
import type { DesktopAPI } from '../shared/types';
declare global { interface Window { desktop: DesktopAPI } }
applyTheme(readCachedTheme());
applyTypography(readCachedTypography());
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
