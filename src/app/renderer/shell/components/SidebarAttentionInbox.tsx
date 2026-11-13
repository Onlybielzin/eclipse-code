import React from 'react'
import { agentAttentionLabelKey } from '@contexts/workspace/presentation/renderer/utils/agentAttentionLabel'
import { useTranslation } from '@app/renderer/i18n'
import { Button } from '@app/renderer/components/ui/Button'
import type { AgentActivityReference } from '../utils/agentActivitySummary'
import { describeWaitDuration, resolveWaitDuration } from '../utils/waitDuration'
import { useAgentWaitingSinceStore, useMinuteClock } from '../hooks/useAgentWaitingSince'
import { ProjectTile } from './ProjectTile'
import type { PendingQuestionReference } from '../utils/pendingQuestions'

/**
 * Everything waiting for you, across projects: question cards first, then agents. One click opens
 * the project and focuses the card or the agent.
 */
export function SidebarAttentionInbox({
  items,
  questions = [],
  onSelectAgentNode,
}: {
  items: readonly AgentActivityReference[]
  questions?: readonly PendingQuestionReference[]
  onSelectAgentNode: (workspaceId: string, nodeId: string) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const observations = useAgentWaitingSinceStore(state => state.observations)
  const total = items.length + questions.length
  const nowMs = useMinuteClock(total > 0)
  if (total === 0) {
    return null
  }

  return (
    <section
      className="workspace-attention-inbox"
      data-testid="workspace-attention-inbox"
      aria-label={t('sidebar.inbox.title')}
    >
      <h3 className="workspace-attention-inbox__title">
        <span>{t('sidebar.inbox.title')}</span>
        <span className="workspace-attention-inbox__count">{total}</span>
      </h3>
      {questions.map(question => {
        const place = `${question.projectName} · ${question.spaceName ?? t('sidebar.rootCanvas')}`
        const status =
          question.questionCount > 1
            ? t('canvasCards.question.inboxStatusMany', { count: question.questionCount })
            : t('canvasCards.question.inboxStatus')
        const duration = resolveWaitDuration(question.createdAtMs, nowMs)
        const waited = duration.unit === 'unknown' ? '' : describeWaitDuration(t, duration)
        return (
          <Button
            key={`${question.workspaceId}:${question.nodeId}`}
            variant="ghost"
            size="sm"
            className="workspace-attention-inbox__item workspace-attention-inbox__item--question"
            data-testid={`workspace-attention-question-${question.workspaceId}-${question.nodeId}`}
            aria-label={t('agentActivity.attentionRow', {
              title: question.question,
              place,
              status,
            })}
            onClick={() => onSelectAgentNode(question.workspaceId, question.nodeId)}
          >
            <ProjectTile
              workspaceId={question.workspaceId}
              iconId={question.projectIconId}
              size="sm"
            />
            <span className="workspace-attention-inbox__item-title">{question.question}</span>
            <span className="workspace-attention-inbox__meta">
              <span className="workspace-attention-inbox__place">
                {question.askerTitle} · {place}
              </span>
              <span className="workspace-attention-inbox__waited">
                {status}
                {waited ? ` · ${waited}` : ''}
              </span>
            </span>
          </Button>
        )
      })}
      {items.map(item => {
        const place = `${item.projectName} · ${item.spaceName ?? t('sidebar.rootCanvas')}`
        const status = t(agentAttentionLabelKey(item))
        const duration = resolveWaitDuration(
          observations.get(item.nodeId)?.waitingSinceMs ?? item.needsYouSinceMs ?? null,
          nowMs,
        )
        const waited = duration.unit === 'unknown' ? '' : describeWaitDuration(t, duration)
        return (
          <Button
            key={`${item.workspaceId}:${item.nodeId}`}
            variant="ghost"
            size="sm"
            className="workspace-attention-inbox__item"
            data-testid={`workspace-attention-item-${item.workspaceId}-${item.nodeId}`}
            aria-label={
              waited
                ? t('sidebar.inbox.rowLabel', { title: item.title, place, waited, status })
                : t('agentActivity.attentionRow', { title: item.title, place, status })
            }
            onClick={() => onSelectAgentNode(item.workspaceId, item.nodeId)}
          >
            <ProjectTile workspaceId={item.workspaceId} iconId={item.projectIconId} size="sm" />
            <span className="workspace-attention-inbox__item-title">{item.title}</span>
            <span className="workspace-attention-inbox__meta">
              <span className="workspace-attention-inbox__place">{place}</span>
              <span className="workspace-attention-inbox__waited">
                {status}
                {waited ? ` · ${waited}` : ''}
              </span>
            </span>
          </Button>
        )
      })}
    </section>
  )
}
