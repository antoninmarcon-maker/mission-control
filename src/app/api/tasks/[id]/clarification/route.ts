import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { mutationLimiter } from '@/lib/rate-limit'
import { requireAgentTaskAccess, requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { answerSetSchema, questionSetSchema, validateAnswers, type Clarification } from '@/lib/task-clarification'

async function mutate(request: NextRequest, params: Promise<{ id: string }>, answering: boolean) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limit = mutationLimiter(request)
  if (limit) return limit
  // Responses are a human decision, never an agent self-approval.
  if (answering && (auth.user.agent_name || auth.user.agent_id || auth.user.id <= 0)) return NextResponse.json({ error: 'Connectez-vous avec un compte utilisateur pour répondre.' }, { status: 403 })
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  const rawId = (await params).id
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) return NextResponse.json({ error: 'Invalid task ID' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const questions = answering ? null : questionSetSchema.safeParse(body)
  const answers = answering ? answerSetSchema.safeParse(body) : null
  if (questions?.success === false || answers?.success === false) return NextResponse.json({ error: 'Questions ou réponses invalides.' }, { status: 400 })
  const db = getDatabase()
  const result = db.transaction(() => {
    const task = db.prepare('SELECT status, assigned_to, metadata FROM tasks WHERE id = ? AND workspace_id = ?').get(Number(rawId), ws.workspaceId) as { status: string; assigned_to: string | null; metadata: string | null } | undefined
    if (!task) return { error: 'Task not found', status: 404 }
    const deny = requireAgentTaskAccess(auth.user, task.assigned_to)
    if (deny) return { error: 'Access denied', status: 403 }
    const metadata = task.metadata ? JSON.parse(task.metadata) : {}
    const previous: Clarification | undefined = metadata.clarification
    let next: Clarification
    const actor = auth.user.display_name || auth.user.username
    const now = Math.floor(Date.now() / 1000)
    if (answering && answers?.success) {
      if (previous?.state !== 'pending' || previous.revision !== answers.data.revision) return { error: 'Le cadrage a changé. Rechargez la tâche avant de répondre.', status: 409 }
      const error = validateAnswers(previous.questions, answers.data.answers)
      if (error) return { error, status: 400 }
      next = { ...previous, state: 'answered', answers: answers.data.answers, answeredBy: actor, answeredAt: now }
    } else if (questions?.success) {
      if (!['backlog', 'inbox', 'assigned', 'awaiting_owner'].includes(task.status)) return { error: 'Le cadrage se prépare avant exécution. Arrêtez proprement le travail en cours avant de le recadrer.', status: 409 }
      if (previous) return { error: 'Cette tâche possède déjà un cadrage. Créez une tâche de suivi pour un nouveau périmètre.', status: 409 }
      next = { state: 'pending', revision: randomUUID(), questions: questions.data.questions, createdBy: actor, createdAt: now }
    } else return { error: 'Invalid request', status: 400 }
    db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(JSON.stringify({ ...metadata, clarification: next }), now, Number(rawId), ws.workspaceId)
    return { clarification: next }
  }).immediate()
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  eventBus.broadcast('task.updated', { id: Number(rawId), workspace_id: ws.workspaceId })
  return NextResponse.json(result, { status: answering ? 200 : 201 })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { return mutate(request, params, false) }
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) { return mutate(request, params, true) }
