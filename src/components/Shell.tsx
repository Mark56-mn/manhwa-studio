import { useState } from 'react'

import { InfoNote } from './ui'

import type { ReactNode } from 'react'

import type { User } from '../lib/api'

const NAV = [
  { path: '/', label: 'Dashboard' },
  { path: '/projects', label: 'Projects' },
  { path: '/integrations', label: 'Settings & Integrations' },
]

export function Shell({
  user,
  path,
  navigate,
  children,
}: {
  user: User | null
  path: string
  navigate: (to: string) => void
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const isActive = (target: string) => (target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`))

  const go = (to: string) => {
    setMenuOpen(false)
    navigate(to)
  }

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => go('/')}>
          <span className="brand-mark">MS</span>
          <span className="brand-text">
            Manhwa Studio
            <small>AI-assisted episode production</small>
          </span>
        </button>

        <div className="topbar-right">
          {user ? (
            <div className="account">
              <span className="account-name">{user.name ?? user.email ?? 'Signed in'}</span>
              <form method="post" action="/auth/freebuff/signout">
                <button className="btn btn-ghost" type="submit">
                  Sign out
                </button>
              </form>
            </div>
          ) : (
            <a className="btn btn-primary" href="/auth/freebuff/signin?returnTo=%2F">
              Sign in with Freebuff
            </a>
          )}
          <button
            className="btn btn-ghost menu-toggle"
            type="button"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </button>
        </div>
      </header>

      <nav className={menuOpen ? 'nav nav-open' : 'nav'} aria-label="Primary">
        {NAV.map((item) => (
          <button
            key={item.path}
            type="button"
            className={isActive(item.path) ? 'nav-item nav-item-active' : 'nav-item'}
            onClick={() => go(item.path)}
          >
            {item.label}
          </button>
        ))}
        <p className="nav-foot">
          Phase B · real script + Director AI
          <br />
          Art, voice and video workers arrive next.
        </p>
      </nav>

      <main className="content">
        {!user && <InfoNote>You are signed out. Project data stays private until you sign in.</InfoNote>}
        {children}
      </main>
    </div>
  )
}
