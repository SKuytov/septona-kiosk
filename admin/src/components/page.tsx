import type { ReactNode } from 'react'
import type { Paged } from '../types'
export function PageHeading({ title, text, action }: { title:string; text?:string; action?:ReactNode }) { return <header className="page-heading"><div><h1>{title}</h1>{text && <p>{text}</p>}</div>{action}</header> }
export function listFrom<T>(value: T[] | Paged<T> | undefined | null): T[] { if (Array.isArray(value)) return value; return value?.items ?? value?.data ?? [] }
export function formatDate(value?: string | null, includeTime = true) { if (!value) return '—'; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('bg-BG',{dateStyle:'medium',...(includeTime ? {timeStyle:'short'} : {})}).format(parsed) }
export function formatBytes(value?: number) { if (!value && value !== 0) return '—'; if (value < 1024) return `${value} B`; if (value < 1024*1024) return `${(value/1024).toFixed(1)} KB`; return `${(value/(1024*1024)).toFixed(1)} MB` }
