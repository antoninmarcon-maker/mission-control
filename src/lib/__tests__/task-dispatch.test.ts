import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { classifyDirectModel, insertDispatchTokenUsage, pickProvider, resolveTaskDispatchModelOverride } from '@/lib/task-dispatch'

describe('insertDispatchTokenUsage', () => {
  it('persists dispatch usage using the current token_usage schema', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE token_usage (
        model TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        workspace_id INTEGER NOT NULL,
        cost_usd REAL
      )
    `)

    insertDispatchTokenUsage(db, {
      model: 'test-model',
      sessionId: 'task-42',
      inputTokens: 120,
      outputTokens: 30,
      workspaceId: 7,
    }, 1_700_000_000)

    expect(db.prepare('SELECT * FROM token_usage').get()).toEqual({
      model: 'test-model',
      session_id: 'task-42',
      input_tokens: 120,
      output_tokens: 30,
      created_at: 1_700_000_000,
      workspace_id: 7,
      cost_usd: 0,
    })
    db.close()
  })
})

describe('resolveTaskDispatchModelOverride', () => {
  it('returns null when the agent has no explicit dispatch model override', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: null })).toBeNull()
    expect(resolveTaskDispatchModelOverride({ agent_config: '{"openclawId":"main"}' })).toBeNull()
  })

  it('returns the explicit dispatch model override when present', () => {
    expect(
      resolveTaskDispatchModelOverride({
        agent_config: '{"openclawId":"main","dispatchModel":"openai-codex/gpt-5.4"}',
      })
    ).toBe('openai-codex/gpt-5.4')
  })

  it('ignores malformed agent config payloads', () => {
    expect(resolveTaskDispatchModelOverride({ agent_config: '{not json' })).toBeNull()
  })
})

describe('MiniMax direct dispatch routing', () => {
  it('selects the dedicated provider for both current model IDs', () => {
    expect(pickProvider('MiniMax-M3')).toBe('minimax')
    expect(pickProvider('minimax/MiniMax-M2.7')).toBe('minimax')
  })
})

describe('classifyDirectModel local provider prefix preservation', () => {
  // Minimal DispatchableTask fixture — only agent_config drives the branch
  // under test (the per-agent dispatchModel override); the remaining fields
  // just satisfy the interface shape and are never read on this path.
  const taskWithDispatchModel = (dispatchModel: string) => ({
    id: 1,
    title: 'test task',
    description: null,
    status: 'todo',
    priority: 'normal',
    assigned_to: 'agent',
    workspace_id: 1,
    agent_name: 'test-agent',
    agent_id: 1,
    agent_config: JSON.stringify({ dispatchModel }),
    ticket_prefix: null,
    project_ticket_no: null,
    project_id: null,
  })

  it('keeps the ollama/ prefix intact so pickProvider still routes to the local backend', () => {
    const task = taskWithDispatchModel('ollama/qwen2.5-coder:7b')
    const model = classifyDirectModel(task)
    expect(model).toBe('ollama/qwen2.5-coder:7b')
    expect(pickProvider(model)).toBe('local')
  })

  it('keeps the local/ prefix intact so pickProvider still routes to the local backend', () => {
    const task = taskWithDispatchModel('local/qwen2.5-coder-7b-instruct')
    const model = classifyDirectModel(task)
    expect(model).toBe('local/qwen2.5-coder-7b-instruct')
    expect(pickProvider(model)).toBe('local')
  })

  it('still strips unrecognized gateway prefixes to the bare model ID (documented "9router/cc/" shape)', () => {
    // docs/agent-setup.md and docs/orchestration.md document dispatchModel
    // values like "9router/cc/claude-opus-4-6" for the gateway-present path.
    // When MC falls back to direct dispatch, the same config value should
    // still resolve to a bare Anthropic model ID.
    const task = taskWithDispatchModel('9router/cc/claude-opus-4-6')
    expect(classifyDirectModel(task)).toBe('claude-opus-4-6')
  })

  it('documents current (unspecified) behavior for a provider marker behind an unrecognized outer prefix', () => {
    // "gateway/ollama/<model>" is not a shape used anywhere in this repo —
    // docs/deployment.md and examples/MULTI-PROVIDER-DEMO.md only document
    // single-segment provider prefixes ("ollama/<model>", "local/<model>",
    // etc). Because the outer segment ("gateway") isn't a recognized
    // provider prefix, this still falls through to the bare-ID strip, same
    // as before this fix — pinned here so a future change to this case is a
    // deliberate decision, not an accidental regression.
    const task = taskWithDispatchModel('gateway/ollama/qwen2.5-coder:7b')
    expect(classifyDirectModel(task)).toBe('qwen2.5-coder:7b')
  })
})
