import type { ReactNode } from 'react'

import { titleCase } from '../lib/format'

import type { EpisodeStatus, IntegrationState, ProjectStatus } from '../lib/api'

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {subtitle && <p className="card-subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function Prompt({ children }: { children: ReactNode }) {
  return <p className="prompt">{children}</p>
}

export function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{text}</span>
      {children}
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="input" />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className="input textarea" />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="input select" />
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }

export function Button({ variant = 'primary', ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-${variant}`} />
}

const PROJECT_TONE: Record<ProjectStatus, string> = {
  development: 'slate',
  in_production: 'violet',
  paused: 'amber',
  completed: 'green',
}

const EPISODE_TONE: Record<EpisodeStatus, string> = {
  planned: 'slate',
  script_drafting: 'blue',
  script_review: 'amber',
  script_approved: 'violet',
  art_generating: 'blue',
  art_review: 'amber',
  audio_generating: 'blue',
  video_assembling: 'blue',
  video_review: 'amber',
  approved: 'green',
  published: 'green',
  failed: 'red',
}

const INTEGRATION_TONE: Record<IntegrationState, string> = {
  connected_verified: 'green',
  configured_unverified: 'amber',
  unavailable: 'red',
  not_configured: 'slate',
  failed: 'red',
}

export function Pill({ tone = 'slate', children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>
}

export function ProjectStatusPill({ status }: { status: ProjectStatus }) {
  return <Pill tone={PROJECT_TONE[status]}>{titleCase(status)}</Pill>
}

export function EpisodeStatusPill({ status }: { status: EpisodeStatus }) {
  return <Pill tone={EPISODE_TONE[status]}>{titleCase(status)}</Pill>
}

export function IntegrationStatePill({ state }: { state: IntegrationState }) {
  return <Pill tone={INTEGRATION_TONE[state]}>{titleCase(state)}</Pill>
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null
  return <p className="note note-error">{children}</p>
}

export function InfoNote({ children }: { children: ReactNode }) {
  return <p className="note note-info">{children}</p>
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="dot" />
      {label}
    </p>
  )
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>
  active: T
  onChange: (id: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={tab.id === active ? 'tab tab-active' : 'tab'}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {typeof tab.badge === 'number' && <span className="tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  )
}
