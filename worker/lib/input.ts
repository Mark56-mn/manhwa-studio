import { badRequest } from './errors'

export interface FieldError {
  field: string
  message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Minimal, explicit request-body reader. Every route declares the fields it
 * accepts, so unknown or malformed input is rejected instead of silently
 * written to the database.
 */
export class Input {
  private readonly body: Record<string, unknown>
  private readonly errors: FieldError[] = []

  constructor(body: unknown) {
    // `undefined` values (for example an absent query parameter) count as
    // "field not provided" rather than as invalid input.
    this.body = isRecord(body)
      ? Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined))
      : {}
  }

  private fail(field: string, message: string): void {
    this.errors.push({ field, message })
  }

  private raw(field: string): unknown {
    return this.body[field]
  }

  has(field: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body, field)
  }

  /** Required non-empty string. */
  string(field: string, max = 4000): string {
    const value = this.raw(field)
    if (typeof value !== 'string' || value.trim().length === 0) {
      this.fail(field, 'Required text value')
      return ''
    }
    if (value.length > max) {
      this.fail(field, `Must be ${max} characters or fewer`)
      return ''
    }
    return value.trim()
  }

  /** Optional string; empty string is treated as "clear this field". */
  optionalString(field: string, max = 20000): string | undefined {
    if (!this.has(field)) return undefined
    const value = this.raw(field)
    if (value === null) return ''
    if (typeof value !== 'string') {
      this.fail(field, 'Must be text')
      return undefined
    }
    if (value.length > max) {
      this.fail(field, `Must be ${max} characters or fewer`)
      return undefined
    }
    return value.trim()
  }

  enum<T extends string>(field: string, allowed: readonly T[]): T | undefined {
    const value = this.optionalString(field, 64)
    if (value === undefined) return undefined
    if (!allowed.includes(value as T)) {
      this.fail(field, `Must be one of: ${allowed.join(', ')}`)
      return undefined
    }
    return value as T
  }

  integer(field: string, { min = 0, max = 100000 }: { min?: number; max?: number } = {}): number | undefined {
    if (!this.has(field)) return undefined
    const value = this.raw(field)
    if (value === null) return undefined
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
      this.fail(field, 'Must be a whole number')
      return undefined
    }
    if (parsed < min || parsed > max) {
      this.fail(field, `Must be between ${min} and ${max}`)
      return undefined
    }
    return parsed
  }

  /** Optional decimal number, e.g. a sampling temperature. */
  number(field: string, { min = -1000000, max = 1000000 }: { min?: number; max?: number } = {}): number | undefined {
    if (!this.has(field)) return undefined
    const value = this.raw(field)
    if (value === null) return undefined
    const parsed = typeof value === 'string' ? Number(value) : value
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
      this.fail(field, 'Must be a number')
      return undefined
    }
    if (parsed < min || parsed > max) {
      this.fail(field, `Must be between ${min} and ${max}`)
      return undefined
    }
    return parsed
  }

  /** Throws a 400 carrying every field error found so far. */
  assertClean(): void {
    if (this.errors.length > 0) {
      throw badRequest('Invalid request body', this.errors)
    }
  }

  /** Rejects bodies containing fields the route does not accept. */
  rejectUnknown(allowed: readonly string[]): void {
    for (const key of Object.keys(this.body)) {
      if (!allowed.includes(key)) this.fail(key, 'Unknown field')
    }
  }
}

export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('Request body must be valid JSON')
  }
}
