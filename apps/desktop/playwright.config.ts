import { defineConfig } from '@playwright/test';
import { testResultsPath } from './tests/helpers/paths';

export default defineConfig({testDir:'tests',testMatch:['desktop.spec.ts','themes.spec.ts','experience.spec.ts','mermaid.spec.ts','ide.spec.ts','inspector.spec.ts','worktree-location.spec.ts','subtasks.spec.ts','session-experience.spec.ts','chat-queue.spec.ts','chat-file-drop.spec.ts','fonts.spec.ts','context-commands.spec.ts','cli-update.spec.ts','engine-ui.spec.ts','native-connections.spec.ts','native-agent.spec.ts'],workers:1,timeout:60000,outputDir:testResultsPath('desktop'),reporter:'list',use:{trace:'retain-on-failure'}});
