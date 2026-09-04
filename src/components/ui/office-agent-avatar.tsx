'use client'

import type { CSSProperties } from 'react'
import type { Agent } from '@/store'
import type { OfficeProjectVisual } from '@/lib/office-layout'

interface OfficeAgentAvatarProps {
  name: string
  status: Agent['status']
  statusLabel: string
  project: OfficeProjectVisual
  moving?: boolean
  className?: string
}

const statusColor: Record<Agent['status'], string> = {
  busy: '#fbbf24',
  idle: '#34d399',
  error: '#fb7185',
  offline: '#64748b',
}

function getInitials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) || '?'
}

function getVariant(name: string): number {
  let hash = 0
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  return hash % 3
}

export function OfficeAgentAvatar({
  name,
  status,
  statusLabel,
  project,
  moving = false,
  className = '',
}: OfficeAgentAvatarProps) {
  const variant = getVariant(name)
  const accent = statusColor[status]
  const style = {
    '--agent-project': project.accent,
    '--agent-status': accent,
  } as CSSProperties

  return (
    <span
      role="img"
      aria-label={`${name} — ${project.label} — ${statusLabel}`}
      title={`${name} · ${project.label} · ${statusLabel}`}
      className={`office-agent-avatar relative block h-12 w-10 ${moving ? 'is-moving' : ''} ${status === 'busy' ? 'is-working' : ''} ${className}`}
      style={style}
    >
      <span className="sr-only">{statusLabel}</span>
      <svg
        viewBox="0 0 40 48"
        className="absolute inset-0 h-full w-full overflow-visible drop-shadow-[0_7px_7px_rgba(0,0,0,0.45)]"
        aria-hidden="true"
        shapeRendering="geometricPrecision"
      >
        <ellipse cx="20" cy="45" rx="12" ry="2.25" fill="rgba(2, 8, 23, 0.58)" />
        <path d="M9 41v-9.5c0-4.7 3.8-8.5 8.5-8.5h5c4.7 0 8.5 3.8 8.5 8.5V41H9Z" fill="var(--agent-project)" />
        <path d="M13 41v-8.5c0-2.5 2-4.5 4.5-4.5h5c2.5 0 4.5 2 4.5 4.5V41H13Z" fill="rgba(4, 12, 24, 0.48)" />
        <path d="M8 31h5v9H8c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2Zm24 0h-5v9h5c1.1 0 2-.9 2-2v-5c0-1.1-.9-2-2-2Z" fill="var(--agent-project)" />
        <rect x="11" y="5" width="18" height="21" rx="7" fill="var(--agent-project)" />
        {variant === 0 && <path d="M13 5.5 16 2h8l3 3.5" fill="none" stroke="var(--agent-project)" strokeWidth="3" strokeLinejoin="round" />}
        {variant === 1 && <path d="M20 5V1m-3 0h6" fill="none" stroke="var(--agent-project)" strokeWidth="2" strokeLinecap="round" />}
        {variant === 2 && <path d="M12 9 8 6m20 3 4-3" fill="none" stroke="var(--agent-project)" strokeWidth="2.5" strokeLinecap="round" />}
        <rect x="14" y="9" width="12" height="11" rx="4" fill="#07111f" stroke="rgba(255,255,255,0.38)" strokeWidth="1" />
        <rect x="16.5" y="13" width="2.5" height="2.5" rx="1" fill="var(--agent-status)" />
        <rect x="21" y="13" width="2.5" height="2.5" rx="1" fill="var(--agent-status)" />
        <path d="M17 18h6" stroke="rgba(226,232,240,0.7)" strokeWidth="1" strokeLinecap="round" />
        <path d="M11 25c2.2 2 5.2 3 9 3s6.8-1 9-3" fill="none" stroke="rgba(255,255,255,0.24)" strokeWidth="1" />
        <path d="M15 41v4m10-4v4" stroke="#0f172a" strokeWidth="4" strokeLinecap="round" />
      </svg>

      <span
        aria-hidden="true"
        className={`absolute -right-1 top-0 grid h-3.5 w-3.5 place-items-center border-2 border-[#07111f] bg-[var(--agent-status)] shadow-[0_2px_6px_rgba(0,0,0,0.45)] ${
          status === 'idle' ? 'rounded-full' : status === 'error' ? '[clip-path:polygon(50%_0,100%_100%,0_100%)]' : status === 'offline' ? 'rounded-sm saturate-0' : 'rounded-[3px]'
        }`}
      >
        {status === 'busy' && <span className="h-1 w-1 rounded-full bg-[#07111f]" />}
        {status === 'offline' && <span className="h-0.5 w-1.5 bg-[#07111f]" />}
      </span>

      <span
        aria-hidden="true"
        className="absolute bottom-[7px] left-1/2 min-w-5 -translate-x-1/2 rounded-[3px] border border-white/15 bg-[#07111f]/85 px-1 py-px text-center font-mono text-[7px] font-bold leading-none text-white"
      >
        {getInitials(name)}
      </span>
    </span>
  )
}
