'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useLayoutEffect, useRef, useState } from 'react'
import type { TaskProposal } from '@/lib/task-proposals'
import { Button } from '@/components/ui/button'

export type ProposalEdit = Partial<Pick<TaskProposal, 'title' | 'objective' | 'context'>>
type EditResult = boolean | void | { rebase: TaskProposal }

export type ProposalCardProps = {
  proposal: TaskProposal
  compact?: boolean
  onAccept: (proposal: TaskProposal) => Promise<void>
  onEdit: (proposal: TaskProposal, patch: ProposalEdit) => Promise<EditResult>
  onDismiss: (proposal: TaskProposal, reason?: string) => Promise<void>
}

function formatAge(createdAt: number, locale: string) {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - createdAt) / 60))
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (minutes < 60) return formatter.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  return formatter.format(-Math.floor(hours / 24), 'day')
}

export function ProposalCard({ proposal, compact = false, onAccept, onEdit, onDismiss }: ProposalCardProps) {
  const t = useTranslations('taskProposals')
  const tc = useTranslations('common')
  const locale = useLocale()
  const [busy, setBusy] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editBase, setEditBase] = useState(proposal)
  const [draft, setDraft] = useState(() => ({ title: proposal.title, objective: proposal.objective, context: proposal.context }))
  const [failure, setFailure] = useState(false)
  const modifyRef = useRef<HTMLButtonElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const restoreEditorFocus = useRef(false)
  const isPending = proposal.status === 'pending'

  useLayoutEffect(() => {
    if (editing) titleRef.current?.focus()
    else if (restoreEditorFocus.current && !busy) {
      modifyRef.current?.focus()
      restoreEditorFocus.current = false
    }
  }, [editing, busy])

  function openEditor() {
    if (editing) return
    setEditBase(proposal)
    setDraft({ title: proposal.title, objective: proposal.objective, context: proposal.context })
    setFailure(false)
    setEditing(true)
  }

  function closeEditor() {
    restoreEditorFocus.current = true
    setEditing(false)
  }

  async function run(action: () => Promise<EditResult>) {
    setBusy(true)
    setFailure(false)
    try {
      return await action()
    } catch {
      setFailure(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit() {
    const patch: ProposalEdit = {}
    if (draft.title.trim() !== editBase.title) patch.title = draft.title.trim()
    if (draft.objective.trim() !== editBase.objective) patch.objective = draft.objective.trim()
    if (draft.context.trim() !== editBase.context) patch.context = draft.context.trim()
    if (Object.keys(patch).length === 0) {
      closeEditor()
      return
    }
    const result = await run(() => onEdit(editBase, patch))
    if (result && typeof result === 'object') {
      const latest = result.rebase
      setDraft({
        title: draft.title.trim() === editBase.title ? latest.title : draft.title,
        objective: draft.objective.trim() === editBase.objective ? latest.objective : draft.objective,
        context: draft.context.trim() === editBase.context ? latest.context : draft.context,
      })
      setEditBase(latest)
    } else if (result !== false) closeEditor()
  }

  return (
    <article className={`w-full max-w-full min-w-0 break-words border border-border border-l-2 border-l-primary bg-card text-left ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{proposal.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{proposal.objective}</p>
        </div>
        <span className="shrink-0 border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-2xs font-medium uppercase tracking-wide text-warning">
          {proposal.risk.toUpperCase()}
        </span>
      </div>

      <p className="mt-3 text-xs leading-5 text-foreground/80"><span className="font-medium text-foreground">{t('whyNow')}:</span> {proposal.rationale}</p>
      <div className="mt-3 space-y-1 font-mono text-2xs text-muted-foreground">
        <p className="break-words">{proposal.sourceType} · {proposal.sourceRef} · {formatAge(proposal.createdAt, locale)}</p>
        {proposal.routeForecast && <p>{t('forecast')}: {proposal.routeForecast.runtime}{proposal.routeForecast.model ? ` / ${proposal.routeForecast.model}` : ''}</p>}
        {proposal.routeForecast && <p className="font-sans">{proposal.routeForecast.reason}</p>}
        {proposal.routeForecast && <p className="font-sans text-muted-foreground">{t('forecastDisclaimer')}</p>}
      </div>

      {proposal.status === 'accepted' && proposal.taskId !== null ? (
        <a href={`?taskId=${proposal.taskId}`} className="mt-4 inline-flex min-h-9 items-center border border-success/30 bg-success/10 px-3 text-sm font-medium text-success focus-visible:outline-2 focus-visible:outline-primary">
          {t('accepted')}
        </a>
      ) : isPending && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={busy} className="h-auto min-h-8 max-w-full whitespace-normal" size="sm" onClick={() => void run(() => onAccept(proposal))}>
            {t('validateLaunch')}
          </Button>
          <Button ref={modifyRef} disabled={busy} className="h-auto min-h-8 max-w-full whitespace-normal" size="sm" variant="outline" aria-expanded={editing} aria-controls={`proposal-editor-${proposal.id}`} onClick={openEditor}>
            {t('modify')}
          </Button>
          <Button disabled={busy} className="h-auto min-h-8 max-w-full whitespace-normal" size="sm" variant="ghost" onClick={() => void run(() => onDismiss(proposal))}>
            {t('dismiss')}
          </Button>
        </div>
      )}

      {failure && <p role="alert" className="mt-3 text-xs text-destructive">{t('failed')}</p>}

      {editing && isPending && (
        <form id={`proposal-editor-${proposal.id}`} className="mt-4 space-y-3 border-t border-border pt-3" onSubmit={(event) => { event.preventDefault(); void saveEdit() }}>
          <label className="block text-xs font-medium text-muted-foreground">
            {t('editTitle')}
            <input ref={titleRef} disabled={busy} className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            {t('editObjective')}
            <textarea disabled={busy} className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" rows={2} value={draft.objective} onChange={(event) => setDraft({ ...draft, objective: event.target.value })} />
          </label>
          <label className="block text-xs font-medium text-muted-foreground">
            {t('context')}
            <textarea disabled={busy} className="mt-1 w-full border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-primary" rows={3} value={draft.context} onChange={(event) => setDraft({ ...draft, context: event.target.value })} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} size="sm" type="submit">{tc('save')}</Button>
            <Button disabled={busy} size="sm" type="button" variant="ghost" onClick={closeEditor}>{tc('cancel')}</Button>
          </div>
        </form>
      )}

      <div className="mt-4 border-t border-border pt-3">
        <button type="button" className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-primary" aria-expanded={contextOpen} aria-controls={`proposal-context-${proposal.id}`} onClick={() => setContextOpen((open) => !open)}>
          {t('context')}
        </button>
        {contextOpen && <p id={`proposal-context-${proposal.id}`} className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{proposal.context}</p>}
      </div>
    </article>
  )
}
