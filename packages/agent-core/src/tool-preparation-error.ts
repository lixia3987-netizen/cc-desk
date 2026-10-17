const SKILL_ACTIONS = Object.freeze({
  context_unconfirmed: 'continue_model',
  source_changed: 'restart_turn',
  activation_changed: 'prepare_again',
  activation_blocked: 'settle_operations',
  output_limit: 'adjust_skill_limits',
  skill_limit: 'adjust_skill_limits',
} as const)

export type SkillPreparationFeedback = {
  [Code in keyof typeof SKILL_ACTIONS]: {
    error: 'skill_precondition_failed'; code: Code; action: typeof SKILL_ACTIONS[Code]
  }
}[keyof typeof SKILL_ACTIONS]

/** 仅允许工具准备阶段公开的固定纠正提示；不能携带异常原文或任意字符串。 */
export type ToolPreparationFeedback =
  | { error: 'task_revision_changed'; currentRevision: number; readTask: true }
  | { error: 'code_location_line_range_invalid'; lineCount: number; readFile: true }
  | SkillPreparationFeedback

const trustedErrors = new WeakSet<object>()

function copyFeedback(value: unknown): ToolPreparationFeedback | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    // 不执行 getter、toJSON 或代理返回的任意文本；非枚举及 symbol 额外字段同样拒绝。
    if (keys.length !== 3 || keys.some(key => typeof key !== 'string')) return null
    if (keys.some(key => !('value' in descriptors[key as string]) || !descriptors[key as string].enumerable)) return null
    const error = descriptors.error?.value
    if (error === 'task_revision_changed' && keys.every(key => ['error', 'currentRevision', 'readTask'].includes(key as string))) {
      const currentRevision: unknown = descriptors.currentRevision?.value
      if (typeof currentRevision === 'number' && Number.isSafeInteger(currentRevision) && currentRevision > 0 && descriptors.readTask?.value === true) {
        return { error: 'task_revision_changed', currentRevision, readTask: true }
      }
    } else if (error === 'code_location_line_range_invalid' && keys.every(key => ['error', 'lineCount', 'readFile'].includes(key as string))) {
      const lineCount: unknown = descriptors.lineCount?.value
      if (typeof lineCount === 'number' && Number.isSafeInteger(lineCount) && lineCount >= 0 && descriptors.readFile?.value === true) {
        return { error: 'code_location_line_range_invalid', lineCount, readFile: true }
      }
    } else if (error === 'skill_precondition_failed' && keys.every(key => ['error', 'code', 'action'].includes(key as string))) {
      const code: unknown = descriptors.code?.value
      if (typeof code === 'string' && Object.hasOwn(SKILL_ACTIONS, code)) {
        const checkedCode = code as keyof typeof SKILL_ACTIONS
        const action = SKILL_ACTIONS[checkedCode]
        if (descriptors.action?.value === action) return { error: 'skill_precondition_failed', code: checkedCode, action } as SkillPreparationFeedback
      }
    }
  } catch { /* 无法安全检查的对象按普通异常处理，不能透传其内容。 */ }
  return null
}

export function validateToolPreparationFeedback(value: unknown): value is ToolPreparationFeedback {
  return copyFeedback(value) !== null
}

export class ToolPreparationError extends Error {
  readonly feedback: ToolPreparationFeedback

  constructor(feedback: ToolPreparationFeedback) {
    const safe = copyFeedback(feedback)
    if (!safe) throw new TypeError('Invalid tool preparation feedback')
    super('Tool preparation requires refreshed input')
    this.name = 'ToolPreparationError'
    this.feedback = Object.freeze(safe)
    trustedErrors.add(this)
  }
}

/** 在 core 或宿主 RPC 边界再次验证实例，并返回只含白名单原始值的新对象。 */
export function getToolPreparationFeedback(error: unknown): ToolPreparationFeedback | null {
  try {
    if (error === null || typeof error !== 'object' || !trustedErrors.has(error) || !(error instanceof ToolPreparationError)) return null
    const descriptor = Object.getOwnPropertyDescriptor(error, 'feedback')
    return descriptor && 'value' in descriptor ? copyFeedback(descriptor.value) : null
  } catch { return null }
}
