import { useCallback, useEffect, useState } from 'react'

function currentPath(): string {
  const hash = window.location.hash.replace(/^#/, '')
  return hash.length > 0 ? hash : '/'
}

export function useRoute(): { path: string; navigate: (to: string) => void } {
  const [path, setPath] = useState(currentPath)

  useEffect(() => {
    const onChange = () => setPath(currentPath())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  const navigate = useCallback((to: string) => {
    window.location.hash = to
    window.scrollTo({ top: 0 })
  }, [])

  return { path, navigate }
}

export interface RouteMatch {
  name: 'dashboard' | 'projects' | 'project' | 'integrations' | 'not-found'
  projectId?: string
}

export function matchRoute(path: string): RouteMatch {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0) return { name: 'dashboard' }
  if (segments[0] === 'projects') {
    if (segments.length === 1) return { name: 'projects' }
    if (segments.length === 2) return { name: 'project', projectId: decodeURIComponent(segments[1] ?? '') }
  }
  if (segments[0] === 'integrations') return { name: 'integrations' }
  return { name: 'not-found' }
}
