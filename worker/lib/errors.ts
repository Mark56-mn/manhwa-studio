export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, message: string, code: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function badRequest(message: string, details?: unknown): HttpError {
  return new HttpError(400, message, 'bad_request', details)
}

export function notFound(message = 'Not found'): HttpError {
  return new HttpError(404, message, 'not_found')
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message, 'conflict')
}
