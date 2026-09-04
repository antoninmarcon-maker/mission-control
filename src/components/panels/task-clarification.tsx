'use client'

import { useState } from 'react'
import { type Clarification, type ClarificationAnswer, type ClarificationQuestion, validateAnswers } from '@/lib/task-clarification'

const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary'
const buttonClass = 'min-h-11 rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 disabled:cursor-not-allowed'
const emptyQuestion = (n: number): ClarificationQuestion => ({ id: `q${n}`, prompt: '', multiple: false, options: [{ id: 'a', label: '' }, { id: 'b', label: '' }] })

export function TaskClarification({ taskId, value, canEdit, canCreate = true, onUpdate }: {
  taskId: number; value?: Clarification; canEdit: boolean; canCreate?: boolean; onUpdate: () => void;
}) {
  const [saved, setSaved] = useState(value)
  const current = saved ?? value
  const [composing, setComposing] = useState(false)
  const [questions, setQuestions] = useState([emptyQuestion(1)])
  const [answers, setAnswers] = useState<ClarificationAnswer[]>(() => value?.questions.map(q => ({ questionId: q.id, selected: [], text: '' })) ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(method: 'POST' | 'PUT', body: unknown) {
    setBusy(true); setError('')
    try {
      const res = await fetch(`/api/tasks/${taskId}/clarification`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Enregistrement impossible. Réessayez.')
      setSaved(data.clarification)
      if (method === 'POST') setAnswers(data.clarification.questions.map((q: ClarificationQuestion) => ({ questionId: q.id, selected: [], text: '' })))
      setComposing(false); onUpdate()
    } catch (e) { setError(e instanceof Error ? e.message : 'Connexion interrompue. Vos réponses sont conservées ici.') }
    finally { setBusy(false) }
  }
  const updateQuestion = (index: number, q: ClarificationQuestion) => setQuestions(questions.map((old, i) => i === index ? q : old))
  const updateAnswer = (id: string, patch: Partial<ClarificationAnswer>) => setAnswers(answers.map(a => a.questionId === id ? { ...a, ...patch } : a))
  const complete = current?.questions.filter(q => !validateAnswers([q], answers.filter(a => a.questionId === q.id))).length ?? 0

  return <section className="rounded-lg border border-border p-4 space-y-4" aria-label="Cadrage de la tâche">
    <div>
      <h3 className="font-medium">{current?.state === 'answered' ? 'Cadrage validé' : 'À préciser'}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{current?.state === 'answered'
        ? `Réponses enregistrées par ${current.answeredBy}. Elles seront transmises à l’agent. Cela ne lance pas la tâche.`
        : 'Cadrez le travail avant son lancement. Une réponse libre peut remplacer les choix proposés.'}</p>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!current && !composing && (canEdit && canCreate
      ? <button type="button" className={buttonClass} onClick={() => setComposing(true)}>Préciser cette tâche</button>
      : <p className="text-sm text-muted-foreground">Aucun cadrage demandé{!canCreate ? ' — disponible avant exécution' : ''}.</p>)}
    {!current && composing && <form className="space-y-5" onSubmit={e => { e.preventDefault(); void submit('POST', { questions }) }}>
      {questions.map((q, i) => <fieldset disabled={busy} key={q.id} className="space-y-3 border-t border-border pt-4">
        <legend className="text-sm font-medium px-1">Question {i + 1}</legend>
        <label className="block text-sm">Question à trancher
          <input required maxLength={1000} className={inputClass} value={q.prompt} onChange={e => updateQuestion(i, { ...q, prompt: e.target.value })} />
        </label>
        <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" checked={q.multiple} onChange={e => updateQuestion(i, { ...q, multiple: e.target.checked })} />Plusieurs réponses possibles</label>
        {q.options.map((o, j) => <div key={o.id} className="space-y-2 pl-3 border-l border-border">
          <label className="block text-sm">Option {j + 1}<input required maxLength={240} className={inputClass} value={o.label} onChange={e => updateQuestion(i, { ...q, options: q.options.map((old, k) => k === j ? { ...old, label: e.target.value } : old) })} /></label>
          <label className="flex items-center gap-3 min-h-11 text-sm"><input type="checkbox" checked={!!o.recommended} onChange={e => updateQuestion(i, { ...q, options: q.options.map((old, k) => k === j ? { ...old, recommended: e.target.checked } : old) })} />Option recommandée</label>
          {o.recommended && <label className="block text-sm">Pourquoi ce choix ?<input required maxLength={500} className={inputClass} value={o.reason ?? ''} onChange={e => updateQuestion(i, { ...q, options: q.options.map((old, k) => k === j ? { ...old, reason: e.target.value } : old) })} /></label>}
          {q.options.length > 2 && <button type="button" className={buttonClass} onClick={() => updateQuestion(i, { ...q, options: q.options.filter((_, k) => k !== j) })}>Retirer l’option {j + 1}</button>}
        </div>)}
        {q.options.length < 8 && <button type="button" className={buttonClass} onClick={() => updateQuestion(i, { ...q, options: [...q.options, { id: crypto.randomUUID(), label: '' }] })}>Ajouter une option</button>}
        {questions.length > 1 && <button type="button" className={buttonClass} onClick={() => setQuestions(questions.filter((_, k) => k !== i))}>Retirer cette question</button>}
      </fieldset>)}
      <div className="flex flex-wrap gap-2">
        {questions.length < 6 && <button disabled={busy} type="button" className={buttonClass} onClick={() => setQuestions([...questions, { ...emptyQuestion(questions.length + 1), id: crypto.randomUUID() }])}>Ajouter une question</button>}
        <button disabled={busy} className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>{busy ? 'Enregistrement…' : 'Demander ce cadrage'}</button>
        <button disabled={busy} type="button" className={buttonClass} onClick={() => setComposing(false)}>Annuler</button>
      </div>
    </form>}
    {current && <form className="space-y-5" onSubmit={e => { e.preventDefault(); void submit('PUT', { revision: current.revision, answers }) }}>
      {current.questions.map((q, index) => {
        const answer = (current.state === 'answered' ? current.answers : answers)?.find(a => a.questionId === q.id)
        return <fieldset key={q.id} disabled={busy || !canEdit || current.state === 'answered'} className="space-y-2">
          <legend className="text-sm font-medium mb-2">{index + 1}. {q.prompt}</legend>
          <p className="text-xs text-muted-foreground">{q.multiple ? 'Plusieurs choix possibles' : 'Un seul choix'} · ou votre réponse libre</p>
          {q.options.map(o => <label key={o.id} className={`flex items-start gap-3 min-h-11 rounded-md border p-3 cursor-pointer focus-within:ring-2 focus-within:ring-primary ${answer?.selected.includes(o.id) ? 'border-primary bg-primary/5' : 'border-border'}`}>
            <input className="mt-1 shrink-0" type={q.multiple ? 'checkbox' : 'radio'} name={`${taskId}-${q.id}`} checked={answer?.selected.includes(o.id) ?? false} onChange={e => updateAnswer(q.id, { selected: q.multiple ? (e.target.checked ? [...(answer?.selected ?? []), o.id] : (answer?.selected ?? []).filter(id => id !== o.id)) : [o.id] })} />
            <span className="min-w-0 text-sm break-words">{o.label}{o.recommended && <span className="ml-2 text-xs font-medium text-primary">Recommandé</span>}{o.reason && <span className="block mt-1 text-xs text-muted-foreground">{o.reason}</span>}</span>
          </label>)}
          <label className="block text-sm pt-1">Votre précision pour la question {index + 1}
            <textarea rows={2} maxLength={2000} className={`${inputClass} mt-1`} value={answer?.text ?? ''} onChange={e => updateAnswer(q.id, { text: e.target.value })} />
          </label>
          {current.state === 'pending' && !!answer?.selected.length && <button type="button" className={buttonClass} onClick={() => updateAnswer(q.id, { selected: [] })}>Effacer la sélection</button>}
        </fieldset>
      })}
      {current.state === 'pending' && <div className="space-y-2">
        <p className="text-sm text-muted-foreground" aria-live="polite">{complete}/{current.questions.length} réponses prêtes · lancement automatique bloqué</p>
        <button disabled={busy || !canEdit || !!validateAnswers(current.questions, answers)} className={`${buttonClass} w-full sm:w-auto bg-primary text-primary-foreground hover:bg-primary/90`}>{busy ? 'Enregistrement…' : 'Valider mes réponses'}</button>
      </div>}
    </form>}
  </section>
}
