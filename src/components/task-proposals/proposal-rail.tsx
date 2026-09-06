'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import type { TaskProposal } from '@/lib/task-proposals'
import { useMissionControl } from '@/store'
import { ProposalCard, type ProposalEdit } from './proposal-card'

type ProposalResponse = { proposal: TaskProposal }
type ProposalAcceptanceResponse = ProposalResponse & { task: { id: number; title: string } }

export function ProposalRail() {
  const user = useMissionControl((state) => state.currentUser)
  // Workspace changes discard accepted links, drafts and all request lifetimes.
  return <ScopedProposalRail key={`${user?.tenant_id}:${user?.workspace_id}:${user?.id}`} />
}

function ScopedProposalRail() {
  const t = useTranslations('taskProposals')
  const tc = useTranslations('common')
  const { proposals, reloadProposals, invalidateProposalReloads, updateProposal, removeProposal } = useMissionControl()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [acceptedProposals, setAcceptedProposals] = useState<TaskProposal[]>([])
  const lifetime = useRef<AbortController | null>(null)
  const railRef = useRef<HTMLElement>(null)
  const focusedProposal = useRef<number | null>(null)
  const acceptedFocus = useRef<number | null>(null)
  const acceptingProposal = useRef<number | null>(null)
  const previousOrder = useRef<number[]>([])
  const loadSequence = useRef(0)

  const load = useCallback(async () => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return false
    const sequence = ++loadSequence.current
    setLoading(true)
    try {
      const loaded = await reloadProposals(signal)
      if (signal.aborted || sequence !== loadSequence.current) return false
      if (loaded) setError(null)
      return loaded
    } catch {
      if (!signal.aborted && sequence === loadSequence.current) setError(t('failed'))
      return false
    } finally {
      if (!signal.aborted && sequence === loadSequence.current) setLoading(false)
    }
  }, [reloadProposals, t])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    void load()
    return () => { controller.abort() }
  }, [load])

  const handleFailure = useCallback(async (err: unknown, signal: AbortSignal) => {
    if (signal.aborted) return
    if (err instanceof ApiError && err.status === 409) {
      invalidateProposalReloads()
      if (await load() && !signal.aborted) {
        setError(t('stale'))
        return true
      }
    } else setError(t('failed'))
    return false
  }, [invalidateProposalReloads, load, t])

  const accept = useCallback(async (proposal: TaskProposal) => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    acceptingProposal.current = proposal.id
    try {
      const data = await apiFetch<ProposalAcceptanceResponse>(`/api/task-proposals/${proposal.id}/accept`, {
        method: 'POST', body: JSON.stringify({ revision: proposal.revision }), signal,
      })
      if (signal.aborted) return
      if (focusedProposal.current === proposal.id) acceptedFocus.current = proposal.id
      updateProposal(data.proposal)
      setAcceptedProposals((current) => current.some((accepted) => accepted.id === data.proposal.id)
        ? current.map((accepted) => accepted.id === data.proposal.id ? data.proposal : accepted)
        : [data.proposal, ...current])
      setError(null)
    } catch (err) {
      await handleFailure(err, signal)
    } finally {
      acceptingProposal.current = null
    }
  }, [handleFailure, updateProposal])

  const edit = useCallback(async (proposal: TaskProposal, patch: ProposalEdit) => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return false
    try {
      const data = await apiFetch<ProposalResponse>(`/api/task-proposals/${proposal.id}`, {
        method: 'PUT', body: JSON.stringify({ revision: proposal.revision, action: 'edit', ...patch }), signal,
      })
      if (signal.aborted) return false
      updateProposal(data.proposal)
      setError(null)
      return true
    } catch (err) {
      if (await handleFailure(err, signal)) {
        const latest = useMissionControl.getState().proposals.find((item) => item.id === proposal.id && item.status === 'pending')
        if (latest && !signal.aborted) return { rebase: latest }
      }
      return false
    }
  }, [handleFailure, updateProposal])

  const dismiss = useCallback(async (proposal: TaskProposal, reason?: string) => {
    const signal = lifetime.current?.signal
    if (!signal || signal.aborted) return
    try {
      await apiFetch<ProposalResponse>(`/api/task-proposals/${proposal.id}`, {
        method: 'PUT', body: JSON.stringify({ revision: proposal.revision, action: 'dismiss', ...(reason ? { dismissalReason: reason } : {}) }), signal,
      })
      if (signal.aborted) return
      removeProposal(proposal.id)
      setError(null)
    } catch (err) {
      await handleFailure(err, signal)
    }
  }, [handleFailure, removeProposal])

  const acceptedIds = new Set(acceptedProposals.map((proposal) => proposal.id))
  const visible = [
    ...proposals.filter((proposal) => proposal.status === 'pending' && !acceptedIds.has(proposal.id)),
    ...acceptedProposals,
  ]

  useLayoutEffect(() => {
    const rail = railRef.current
    if (!rail) return
    if (acceptedFocus.current !== null) {
      rail.querySelector<HTMLAnchorElement>(`[data-proposal-id="${acceptedFocus.current}"] a`)?.focus()
      acceptedFocus.current = null
    } else if (focusedProposal.current !== null && !visible.some((item) => item.id === focusedProposal.current)
      && acceptingProposal.current !== focusedProposal.current && document.activeElement === document.body) {
      const oldIndex = previousOrder.current.indexOf(focusedProposal.current)
      const next = visible[Math.min(Math.max(oldIndex, 0), visible.length - 1)]
      const target = next && rail.querySelector<HTMLElement>(`[data-proposal-id="${next.id}"] button, [data-proposal-id="${next.id}"] a`)
      ;(target || rail).focus()
    }
    previousOrder.current = visible.map((proposal) => proposal.id)
  })

  return (
    <section ref={railRef} tabIndex={-1} className="min-w-0 max-w-full shrink-0 border-b border-border bg-surface-0 px-4 py-3 focus-visible:outline-2 focus-visible:outline-primary" aria-label={t('title')}
      onFocusCapture={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLElement>('[data-proposal-id]')
        focusedProposal.current = item ? Number(item.dataset.proposalId) : null
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focusedProposal.current = null
      }}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">{t('title')}</h2>
        {!loading && <span className="font-mono text-2xs text-muted-foreground">{visible.filter((proposal) => proposal.status === 'pending').length}</span>}
      </div>
      {error && <div role="alert" className="mb-3 flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"><span>{error}</span><button type="button" className="underline focus-visible:outline-2 focus-visible:outline-primary" onClick={() => void load()}>{tc('retry')}</button></div>}
      {loading && <p role="status" className="text-sm text-muted-foreground">{tc('loading')}</p>}
      {!loading && visible.length === 0 && <p className="text-sm text-muted-foreground">{t('empty')}</p>}
      {visible.length > 0 && (
        <ul className="flex min-w-0 w-full gap-3 overflow-x-auto pb-1" role="list" aria-label={t('title')}>
          {visible.map((proposal) => <li key={proposal.id} data-proposal-id={proposal.id} className="w-[min(22rem,100%)] max-w-full min-w-0 shrink-0">
            <ProposalCard proposal={proposal} compact onAccept={accept} onEdit={edit} onDismiss={dismiss} />
          </li>)}
        </ul>
      )}
    </section>
  )
}
