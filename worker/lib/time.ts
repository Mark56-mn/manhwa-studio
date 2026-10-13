export function nowIso(): string {
  return new Date().toISOString()
}

export function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
