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
  return response.json() as Promise<T>
}

export function apiUrl(path: string) { return url(path) }
export function queryString(values: Record<string, string | number | undefined | null>) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') params.set(key, String(value)) })
  const text = params.toString()
  return text ? `?${text}` : ''
}
