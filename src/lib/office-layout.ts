import type { Agent } from '@/store'

export type OfficeZoneType = 'engineering' | 'operations' | 'research' | 'product' | 'quality' | 'general'

export interface OfficeZoneDefinition {
  id: OfficeZoneType
  label: string
  icon: string
  accentClass: string
  roleKeywords: string[]
}

export interface WorkstationAnchor {
  deskId: string
  seatLabel: string
  row: number
  col: number
  x: number
  y: number
}

export interface ZonedAgent {
  agent: Agent
  anchor: WorkstationAnchor
}

export interface OfficeZoneLayout {
  zone: OfficeZoneDefinition
  workers: ZonedAgent[]
}

export interface OfficeProjectVisual {
  key: string
  label: string
  accent: string
  accentSoft: string
}

type OfficeAgentIdentity = Pick<Agent, 'name' | 'role' | 'config'>

const KNOWN_PROJECTS: Array<OfficeProjectVisual & { patterns: string[] }> = [
  { key: 'nutrisecure', label: 'NutriSecure', accent: '#34d399', accentSoft: 'rgba(52, 211, 153, 0.16)', patterns: ['nutrisecure'] },
  { key: 'my-volley', label: 'My Volley', accent: '#60a5fa', accentSoft: 'rgba(96, 165, 250, 0.16)', patterns: ['myvolley', 'my volley'] },
  { key: 'love-experience', label: 'Love Experience', accent: '#fb7185', accentSoft: 'rgba(251, 113, 133, 0.16)', patterns: ['loveexp', 'love experience'] },
  { key: 'french-sexploration', label: 'French Sexploration', accent: '#c084fc', accentSoft: 'rgba(192, 132, 252, 0.16)', patterns: ['frenchsexploration', 'french sexploration'] },
  { key: 'ops', label: 'Ops', accent: '#fbbf24', accentSoft: 'rgba(251, 191, 36, 0.16)', patterns: ['ops ressources', 'ops-ressources', '/ops'] },
  { key: 'transverse', label: 'Transverse', accent: '#94a3b8', accentSoft: 'rgba(148, 163, 184, 0.16)', patterns: ['controle qualite', 'controle-qualite', 'quality control'] },
  { key: 'mission-control', label: 'Mission Control', accent: '#22d3ee', accentSoft: 'rgba(34, 211, 238, 0.16)', patterns: ['mission control', 'mission-control', 'exec-', 'ship-agent', 'orchestrateur', 'poc-'] },
]

const FALLBACK_PROJECT_COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#2dd4bf', '#f59e0b', '#84cc16']

function readWorkingDirectory(config: Agent['config']): string {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ''
  const localSession = config.localSession
  if (!localSession || typeof localSession !== 'object' || Array.isArray(localSession)) return ''
  return typeof localSession.workingDir === 'string' ? localSession.workingDir : ''
}

function slugToLabel(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

function stableHash(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  return hash
}

export function getAgentProjectVisual(agent: OfficeAgentIdentity): OfficeProjectVisual {
  const workingDirectory = readWorkingDirectory(agent.config)
  const searchable = `${agent.name} ${agent.role} ${workingDirectory}`.toLowerCase()
  const known = KNOWN_PROJECTS.find((project) => project.patterns.some((pattern) => searchable.includes(pattern)))
  if (known) {
    const { patterns: _patterns, ...visual } = known
    return visual
  }

  const directoryName = workingDirectory.split('/').filter(Boolean).at(-1)
  const inferredKey = (directoryName || agent.name.split(/[-_]/)[0] || 'other').toLowerCase()
  const accent = FALLBACK_PROJECT_COLORS[stableHash(inferredKey) % FALLBACK_PROJECT_COLORS.length]
  return {
    key: inferredKey,
    label: slugToLabel(inferredKey),
    accent,
    accentSoft: `${accent}29`,
  }
}

export function getIdleMinutes(lastSeen: number | undefined, nowSeconds = Date.now() / 1000): number | null {
  if (!lastSeen) return null
  return Math.max(0, Math.floor((nowSeconds - lastSeen) / 60))
}

export function sortOfficeAgents(agents: Agent[]): Agent[] {
  const statusPriority: Record<Agent['status'], number> = {
    busy: 0,
    error: 1,
    idle: 2,
    offline: 3,
  }

  return [...agents].sort((a, b) => {
    const byStatus = statusPriority[a.status] - statusPriority[b.status]
    if (byStatus !== 0) return byStatus
    const byProject = getAgentProjectVisual(a).label.localeCompare(getAgentProjectVisual(b).label)
    return byProject !== 0 ? byProject : a.name.localeCompare(b.name)
  })
}

export const OFFICE_ZONES: OfficeZoneDefinition[] = [
  {
    id: 'engineering',
    label: 'Engineering Bay',
    icon: '🧑‍💻',
    accentClass: 'border-cyan-500/30 bg-cyan-500/10',
    roleKeywords: ['engineer', 'dev', 'frontend', 'backend', 'fullstack', 'software', 'developpement', 'developpeur'],
  },
  {
    id: 'operations',
    label: 'Operations Pod',
    icon: '🛠️',
    accentClass: 'border-amber-500/30 bg-amber-500/10',
    roleKeywords: ['ops', 'sre', 'infra', 'platform', 'reliability', 'maintenance', 'gestion', 'base'],
  },
  {
    id: 'research',
    label: 'Research Corner',
    icon: '🔬',
    accentClass: 'border-violet-500/30 bg-violet-500/10',
    roleKeywords: ['research', 'science', 'analyst', 'ai', 'recherche', 'analyse'],
  },
  {
    id: 'product',
    label: 'Product Studio',
    icon: '📐',
    accentClass: 'border-emerald-500/30 bg-emerald-500/10',
    roleKeywords: ['product', 'pm', 'design', 'ux', 'ui', 'produit', 'marketing'],
  },
  {
    id: 'quality',
    label: 'Quality Lab',
    icon: '🧪',
    accentClass: 'border-rose-500/30 bg-rose-500/10',
    roleKeywords: ['qa', 'test', 'quality', 'qualite', 'controle'],
  },
  {
    id: 'general',
    label: 'General Workspace',
    icon: '🏢',
    accentClass: 'border-slate-500/30 bg-slate-500/10',
    roleKeywords: [],
  },
]

function normalizeRole(role: string | undefined): string {
  return String(role || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function getZoneByRole(role: string | undefined): OfficeZoneDefinition {
  const normalized = normalizeRole(role)
  const roleWords = new Set(normalized.split(' ').filter(Boolean))
  for (const zone of OFFICE_ZONES) {
    if (zone.id === 'general') continue
    if (zone.roleKeywords.some((keyword) => roleWords.has(keyword))) {
      return zone
    }
  }
  return OFFICE_ZONES.find((zone) => zone.id === 'general')!
}

function buildAnchor(index: number, columnCount: number): WorkstationAnchor {
  const row = Math.floor(index / columnCount)
  const col = index % columnCount
  const rowLabel = String.fromCharCode(65 + row)
  const seatLabel = `${rowLabel}${col + 1}`
  return {
    deskId: `desk-${seatLabel.toLowerCase()}`,
    seatLabel,
    row,
    col,
    // Useful for future absolute-position movement/collision mechanics.
    x: col * 220 + 110,
    y: row * 160 + 80,
  }
}

export function buildOfficeLayout(agents: Agent[]): OfficeZoneLayout[] {
  const zoneMap = new Map<OfficeZoneType, Agent[]>()
  for (const zone of OFFICE_ZONES) zoneMap.set(zone.id, [])

  for (const agent of agents) {
    const zone = getZoneByRole(agent.role)
    zoneMap.get(zone.id)!.push(agent)
  }

  const result: OfficeZoneLayout[] = []
  for (const zone of OFFICE_ZONES) {
    const workers = zoneMap.get(zone.id) || []
    if (workers.length === 0) continue

    const columns = workers.length >= 8 ? 4 : workers.length >= 4 ? 3 : 2
    const zoned = workers.map((agent, i) => ({
      agent,
      anchor: buildAnchor(i, columns),
    }))

    result.push({ zone, workers: zoned })
  }

  return result.sort((a, b) => b.workers.length - a.workers.length)
}
