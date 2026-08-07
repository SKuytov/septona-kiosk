import type { ApiError } from './types'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
const tokenKey = 'septona.admin.token'
export const authStorage = {
  get: () => localStorage.getItem(tokenKey),
  set: (token: string) => localStorage.setItem(tokenKey, token),
  clear: () => localStorage.removeItem(tokenKey)
}

function url(path: string) { return `${API_BASE}${path}` }

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = authStorage.get()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8')
  let response: Response
  try {
    response = await fetch(url(path), { ...init, headers })
  } catch {
    throw { status: 0, message: 'Няма връзка със сървъра. Опитайте отново по-късно.' } satisfies ApiError
  }
  if (response.status === 401) {
    authStorage.clear()
    window.dispatchEvent(new Event('septona:unauthorized'))
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    throw { status: response.status, code: body?.error?.code, message: body?.error?.message || 'Операцията не бе изпълнена.', payload: body } satisfies ApiError
  }
  if (response.status === 204) return undefined as T
  return normalise(await response.json()) as T
}

/**
 * The API wraps every payload in a named envelope — `{categories: [...]}`,
 * `{documents: [...], total, page, pageSize}`, `{stats: {...}}` and so on. The UI wants
 * the payload itself, plus a uniform `items`/`total` shape for anything paginated.
 * Unwrapping here means no page has to know which key its endpoint happens to use.
 */
const LIST_KEYS = ['categories', 'documents', 'entries', 'users', 'devices', 'versions'] as const
/** Envelopes that always carry the whole payload and are safe to merge upward. */
const MERGE_KEYS = ['stats', 'settings'] as const
/** Single-entity envelopes, unwrapped only when they are the sole key in the body. */
const ENTITY_KEYS = ['category', 'document', 'user', 'device', 'version'] as const

function normalise(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const record = body as Record<string, unknown>

  // The login response is `{token, user}` — both halves are needed, so leave it alone.
  if ('token' in record) return body

  for (const key of LIST_KEYS) {
    if (Array.isArray(record[key])) {
      const items = record[key] as unknown[]
      // Keep every sibling field (total/page/pageSize, and extras such as the
      // recentActivity that rides along with stats) and expose the list three ways so
      // both array-style and paged-style consumers work.
      const { [key]: _list, ...rest } = record
      return Object.assign(items.slice(), rest, {
        items,
        data: items,
        total: typeof record.total === 'number' ? record.total : items.length
      })
    }
  }

  for (const key of MERGE_KEYS) {
    const value = record[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const { [key]: _obj, ...rest } = record
      return { ...(value as Record<string, unknown>), ...rest }
    }
  }

  if (Object.keys(record).length === 1) {
    for (const key of ENTITY_KEYS) {
      const value = record[key]
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    }
  }

  return body
}

export function apiUrl(path: string) { return url(path) }

/**
 * URL for an inline PDF preview/open. An <iframe> or a new tab cannot carry the
 * Authorization header, so the JWT rides along as a query param; the server accepts
 * it only for GETs on this one read-only route.
 */
export function fileUrl(path: string) {
  const token = authStorage.get()
  if (!token) return url(path)
  return `${url(path)}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}
export function queryString(values: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params.set(key, String(value)) })
  const text = params.toString()
  return text ? `?${text}` : ''
}
