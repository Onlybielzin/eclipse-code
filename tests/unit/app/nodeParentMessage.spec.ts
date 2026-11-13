import { afterEach, expect, it } from 'vitest'
import { toErrorMessage } from '@app/renderer/shell/utils/format'
import { applyUiLanguage } from '@app/renderer/i18n'
import { createAppError, formatAppErrorMessage } from '../../../src/shared/errors/appError'

afterEach(async () => {
  await applyUiLanguage('en')
})
it.each([
  [
    'no_parent',
    'This node was started by the user, so it has no parent agent.',
    'Use "eclipse-code agent list" to choose a recipient, or report your findings to the user.',
    '此节点由用户启动，没有父级 Agent。',
    '运行“eclipse-code agent list”选择接收方，或直接向用户汇报。',
  ],
  [
    'parent_deleted',
    'The agent that created this node has been deleted.',
    'Use "eclipse-code agent list" to choose another recipient, or leave your findings in a shared note.',
    '创建此节点的 Agent 已被删除。',
    '运行“eclipse-code agent list”选择其他接收方，或将结果写入共享便签。',
  ],
  [
    'caller_identity_required',
    '@parent works only inside an Eclipse Code terminal.',
    'Run this command inside Eclipse Code, or replace @parent with a node ID from "eclipse-code node list".',
    '@parent 只能在 Eclipse Code 终端内使用。',
    '请在 Eclipse Code 中运行此命令，或运行“eclipse-code node list”获取节点 ID，用它替换 @parent。',
  ],
  [
    'caller_identity_mismatch',
    'The current terminal identity does not match its Eclipse Code session.',
    'Open a new Eclipse Code terminal and run "eclipse-code whoami" before choosing a recipient.',
    '当前终端的身份与其 Eclipse Code 会话不一致。',
    '请新建一个 Eclipse Code 终端，运行“eclipse-code whoami”确认身份后再选择接收方。',
  ],
  [
    'unknown_reason',
    'The parent node could not be resolved.',
    'Run "eclipse-code node get --node @self" to inspect your lineage, then choose a recipient with "eclipse-code node list".',
    '无法确定父节点。',
    '运行“eclipse-code node get --node @self”查看创建关系，再运行“eclipse-code node list”选择接收方。',
  ],
])('explains %s with recovery guidance in both languages', async (reason, en, hint, zh, zhHint) => {
  const error = createAppError(
    reason === 'caller_identity_mismatch' ? 'common.forbidden' : 'node.parent_unavailable',
    { details: { reason } },
  )
  expect(formatAppErrorMessage(error)).toBe(en)
  await applyUiLanguage('en')
  expect(toErrorMessage(error)).toBe(`${en} ${hint}`)
  await applyUiLanguage('zh-CN')
  expect(toErrorMessage(error.toDescriptor())).toBe(`${zh} ${zhHint}`)
})
