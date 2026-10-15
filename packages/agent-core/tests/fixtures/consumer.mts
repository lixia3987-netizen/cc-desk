import { runAgent, ToolPreparationError, getToolPreparationFeedback, type ToolPreparationFeedback } from '@cc-desk/agent-core';
void runAgent;
const feedback: ToolPreparationFeedback = { error: 'task_revision_changed', currentRevision: 1, readTask: true };
void getToolPreparationFeedback(new ToolPreparationError(feedback));
