import type { ClaudeHost } from '@cc-desk/engine-claude';
import { SessionTitles, type SessionTitleGenerator } from '../../session-titles';
import { ChatHistory } from '../../chat-history';
import { ChatArchive } from '../../chat-archive';
import { ChatDisplayReader } from '../../chat-display-reader';
import { SubtaskTracker } from '../../subtask-tracker';
import { cliInvocation } from '../../commands';
import { environment } from '../../platform-commands';
import { signalPosixGroup } from '../../posix-process-group';
import type { StateStore } from '../../store';
import { claudeSessionPatch, projectClaudeSession } from './session';
import type { ChatPageOptions } from '../../../shared/chat';

const observe = (callback: () => void) => { try { callback(); } catch { /* 观察者不能改变执行或持久化结果。 */ } };

/** 唯一可访问应用持久化及显示策略的结构化 Claude 适配器。 */
export function createClaudeHost(store: StateStore, onState: () => void, onConversation: (id: string) => void, titleGenerator?: SessionTitleGenerator): ClaudeHost {
  const titles = new SessionTitles(store, () => observe(onState), titleGenerator);
  return {
    metadata: titles,
    sessions: {
      get(id) {
        const session = store.state.sessions.find(item => item.id === id);
        return session && projectClaudeSession(session, store.state.projects.find(project => project.id === session.projectId)?.path);
      },
      update(id, patch) {
        try {
          store.change(state => {
            const session = state.sessions.find(item => item.id === id);
            if (!session) throw new Error('会话不存在。');
            Object.assign(session, claudeSessionPatch(session, patch), { updatedAt: new Date().toISOString() });
          });
        } catch (cause) {
          const error = new Error('保存 Claude 会话状态失败：' + (cause instanceof Error ? cause.message : String(cause)), { cause });
          error.name = 'ClaudePersistenceError';
          throw error;
        }
      },
    },
    conversations({ isActive, onError }) {
      const history = new ChatHistory(store.directory, isActive, onError);
      const archive = new ChatArchive(history.directory);
      const display = new ChatDisplayReader(history.directory);
      const forget = archive.forget.bind(archive);
      return { history, archive: Object.assign(archive, {
        readDisplay: (id: string, options?: ChatPageOptions) => display.page(id, options, {
          conversationId: store.state.sessions.find(session => session.id === id)?.execution.conversationId,
        }),
        forget(id: string) { forget(id); display.forget(id); },
      }) };
    },
    subtasks: notify => new SubtaskTracker(store, notify),
    launch: { environment, invocation: env => cliInvocation(store.state.settings, env) },
    maxSessions: () => store.state.settings.maxSessions,
    signalProcessGroup: signalPosixGroup,
    onState: () => observe(onState),
    onConversation: id => observe(() => onConversation(id)),
    onAcceptedPrompt(id, text, capabilities) { titles.request(id, text, capabilities); },
  };
}
