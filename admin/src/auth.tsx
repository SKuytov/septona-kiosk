import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, authStorage } from './api'
import type { User } from './types'

interface AuthState { token: string | null; user: User | null; login: (email: string, password: string) => Promise<void>; logout: () => void }
const AuthContext = createContext<AuthState | null>(null)
const userKey = 'septona.admin.user'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(authStorage.get())
  const [user, setUser] = useState<User | null>(() => { try { return JSON.parse(localStorage.getItem(userKey) || 'null') } catch { return null } })
  const logout = () => { authStorage.clear(); localStorage.removeItem(userKey); setToken(null); setUser(null) }
  const login = async (email: string, password: string) => {
    const result = await api<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
    authStorage.set(result.token); localStorage.setItem(userKey, JSON.stringify(result.user)); setToken(result.token); setUser(result.user)
  }
  useEffect(() => { window.addEventListener('septona:unauthorized', logout); return () => window.removeEventListener('septona:unauthorized', logout) })
  const value = useMemo(() => ({ token, user, login, logout }), [token, user])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
export function useAuth() { const ctx = useContext(AuthContext); if (!ctx) throw new Error('AuthProvider липсва'); return ctx }
