import { useCallback, useEffect, useState } from 'react'

export interface Resource<T> {
  data: T | null
  error: unknown
  loading: boolean
  /** Re-fetch on demand from an event handler, keeping current data visible. */
  reload: () => Promise<void>
  /** Apply a value returned by a mutation without a second round trip. */
  setData: (data: T) => void
  setError: (error: unknown) => void
}

/**
 * Loads one resource for a mounted page. `loader` must be stable (wrap it in
 * `useCallback`); the page re-fetches when its identity changes, for example
 * when a route parameter changes.
 */
export function useResource<T>(loader: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      const value = await loader()
      setData(value)
      setError(null)
    } catch (cause) {
      setError(cause)
    } finally {
      setLoading(false)
    }
  }, [loader])

  useEffect(() => {
    let active = true
    loader()
      .then((value) => {
        if (!active) return
        setData(value)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [loader])

  return { data, error, loading, reload, setData, setError }
}

export function describeError(error: unknown, fallback = 'Something went wrong'): string {
  if (!error) return ''
  if (error instanceof Error) return error.message
  return fallback
}
