import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:['desktop.spec.ts','themes.spec.ts','experience.spec.ts','mermaid.spec.ts','ide.spec.ts','inspector.spec.ts'],workers:1,timeout:60000,reporter:'list',use:{trace:'retain-on-failure'}});
