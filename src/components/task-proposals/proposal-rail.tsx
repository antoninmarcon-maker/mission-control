'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import type { TaskProposal } from '@/lib/task-proposals'
import { useMissionControl } from '@/store'
import { ProposalCard, type ProposalEdit } from './proposal-card'

type ProposalListResponse = { proposals?: TaskProposal[] }
type ProposalResponse = { proposal: TaskProposal }
type ProposalAcceptanceResponse = ProposalResponse & { task: { id: number; title: string } }

export function ProposalRail() {
  const t = useTranslations('taskProposals')
  const tc = useTranslations('common')
  const { proposals, setProposals, updateProposal, removeProposal } = useMissionControl()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acceptedProposals, setAcceptedProposals] = useState<TaskProposal[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch<ProposalListResponse>('/api/task-proposals?status=pending&limit=20')
      setProposals(data.proposals ?? [])
      setError(null)
    } catch {
      setError(t('failed'))
    } finally {
      setLoading(false)
    }
  }, [setProposals, t])

  useEffect(() => {
    void load()
  }, [load])

  const accept = useCallback(async (proposal: TaskProposal) => {
    try {
      const data = await apiFetch<ProposalAcceptanceResponse>(`/api/task-proposals/${proposal.id}/accept`, {
        method: 'POST', body: JSON.stringify({ revision: proposal.revision }),
      })
      updateProposal(data.proposal)
      setAcceptedProposals((current) => current.some((accepted) => accepted.id === data.proposal.id)
        ? current.map((accepted) => accepted.id === data.proposal.id ? data.proposal : accepted)
        : [data.proposal, ...current])
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await load()
        setError(t('stale'))
        return
      }
      setError(t('failed'))
    }
  }, [load, t, updateProposal])

  const edit = useCallback(async (proposal: TaskProposal, patch: ProposalEdit) => {
    try {
      const data = await apiFetch<ProposalResponse>(`/api/task-proposals/${proposal.id}`, {
        method: 'PUT', body: JSON.stringify({ revision: proposal.revision, action: 'edit', ...patch }),
      })
      updateProposal(data.proposal)
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await load()
        setError(t('stale'))
        return
      }
      setError(t('failed'))
    }
  }, [load, t, updateProposal])

  const dismiss = useCallback(async (proposal: TaskProposal, reason?: string) => {
    try {
      await apiFetch<ProposalResponse>(`/api/task-proposals/${proposal.id}`, {
        method: 'PUT', body: JSON.stringify({ revision: proposal.revision, action: 'dismiss', ...(reason ? { dismissalReason: reason } : {}) }),
      })
      removeProposal(proposal.id)
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await load()
        setError(t('stale'))
        return
      }
      setError(t('failed'))
    }
  }, [load, removeProposal, t])

  const visible = [
    ...proposals.filter((proposal) => proposal.status === 'pending'),
    ...acceptedProposals,
  ]

  return (
    <section className="shrink-0 border-b border-border bg-surface-0 px-4 py-3" aria-label={t('title')}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">{t('title')}</h2>
        {!loading && <span className="font-mono text-2xs text-muted-foreground">{visible.filter((proposal) => proposal.status === 'pending').length}</span>}
      </div>
      {error && <div role="alert" className="mb-3 flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"><span>{error}</span><button type="button" className="underline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void load()}>{tc('retry')}</button></div>}
      {loading ? <p className="text-sm text-muted-foreground">{tc('loading')}</p> : visible.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : (
        <div className="flex gap-3 overflow-x-auto pb-1" role="list" aria-label={t('title')}>
          {visible.map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} compact onAccept={accept} onEdit={edit} onDismiss={dismiss} />)}
        </div>
      )}
    </section>
  )
}
