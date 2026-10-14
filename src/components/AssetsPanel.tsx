import { useCallback, useRef, useState } from 'react'

import { Button, Card, EmptyState, ErrorNote, Label, Select, Spinner } from './ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { describeError, useResource } from '../lib/useResource'

import type { Asset, AssetKind } from '../lib/api'

const KINDS: AssetKind[] = ['image', 'audio', 'video', 'caption', 'other']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * Real object storage for a project. Bytes go to the deployment's bucket; the
 * database only ever holds metadata, so nothing binary is written to D1.
 */
export function AssetsPanel({ projectId }: { projectId: string }) {
  const assets = useResource(
    useCallback(() => api<{ projectId: string; assets: Asset[] }>(`/api/projects/${projectId}/assets`), [projectId]),
  )
  const [kind, setKind] = useState<AssetKind>('image')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function upload(): Promise<void> {
    const file = fileRef.current?.files?.[0]
    if (!file) {
      setError('Choose a file first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.set('kind', kind)
      form.set('name', file.name)
      form.set('file', file)
      await api(`/api/projects/${projectId}/assets`, { method: 'POST', body: form })
      if (fileRef.current) fileRef.current.value = ''
      await assets.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/assets/${id}`, { method: 'DELETE' })
      await assets.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const rows = assets.data?.assets ?? []

  return (
    <div className="stack">
      <Card
        title="Upload an asset"
        subtitle="Bytes go to the deployment's object storage; only metadata is kept in the database."
      >
        <div className="form">
          <div className="form-row">
            <Label text="Kind">
              <Select value={kind} onChange={(event) => setKind(event.target.value as AssetKind)}>
                {KINDS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Label>
            <Label text="File">
              <input ref={fileRef} className="input" type="file" />
            </Label>
          </div>
          <div className="form-actions">
            <Button type="button" disabled={busy} onClick={() => void upload()}>
              {busy ? 'Working…' : 'Upload'}
            </Button>
            <span className="hint">
              If no bucket is attached the studio says so instead of pretending to store anything.
            </span>
          </div>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      <Card title="Assets" subtitle={`${rows.length} stored asset${rows.length === 1 ? '' : 's'}`}>
        {assets.loading && rows.length === 0 ? (
          <Spinner label="Loading assets…" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No assets yet"
            hint="Upload a file above. Later tasks store generated art, narration and video here."
          />
        ) : (
          <ul className="rows">
            {rows.map((asset) => (
              <li className="row" key={asset.id}>
                <span className="row-main">
                  {asset.name || asset.id}
                  <small>
                    {asset.kind} · {asset.contentType} · {formatBytes(asset.byteSize)} ·{' '}
                    {relativeTime(asset.createdAt)}
                  </small>
                </span>
                <span className="verify">
                  <a className="btn btn-ghost" href={asset.contentPath} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <Button variant="ghost" type="button" disabled={busy} onClick={() => void remove(asset.id)}>
                    Delete
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
