import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, queryString } from '../api'
import { Button, EmptyState, ErrorState, Icon } from '../components/ui'
import { formatDate, listFrom, PageHeading } from '../components/page'
import type { AuditEntry, Paged } from '../types'

/**
 * The audit log is read by people who are not developers — an auditor, a ЗБУТ officer, a
 * manager asking who withdrew a document. So nothing here is shown as a raw code or a blob
 * of JSON: the action gets a Bulgarian name, and an expanded row lists only the fields that
 * actually changed, old value beside new value.
 */

const ACTIONS: Record<string, string> = {
  'auth.login': 'Вписване',
  'auth.login.failed': 'Неуспешно вписване',
  'auth.logout': 'Отписване',
  'category.create': 'Създадена категория',
  'category.update': 'Променена категория',
  'category.delete': 'Изтрита категория',
  'category.reorder': 'Пренаредени категории',
  'document.create': 'Качен документ',
  'document.update': 'Променен документ',
  'document.delete': 'Архивиран документ',
  'document.purge': 'Окончателно изтрит документ',
  'document.restore': 'Върнат от архива',
  'document.version.create': 'Качена нова версия',
  'document.version.restore': 'Върната предишна версия',
  'document.import': 'Внесени документи',
  'user.create': 'Създаден потребител',
  'user.update': 'Променен потребител',
  'user.delete': 'Изтрит потребител',
  'device.create': 'Регистрирано устройство',
  'device.update': 'Променено устройство',
  'device.delete': 'Премахнато устройство',
  'device.revoke': 'Отнет достъп на устройство',
  'settings.update': 'Променени настройки',
}

const ENTITIES: Record<string, string> = {
  category: 'Категория',
  document: 'Документ',
  user: 'Потребител',
  device: 'Устройство',
  settings: 'Настройки',
  auth: 'Достъп',
}

/** Field names as they are written on the forms, so the two can be read side by side. */
const FIELDS: Record<string, string> = {
  titleBg: 'Заглавие (BG)',
  titleEn: 'Заглавие (EN)',
  nameBg: 'Име (BG)',
  nameEn: 'Име (EN)',
  name: 'Име',
  email: 'Електронна поща',
  role: 'Роля',
  location: 'Местоположение',
  categoryId: 'Категория',
  language: 'Език',
  pinned: 'Закачен най-горе',
  visible: 'Видима',
  isVisible: 'Видима',
  sortOrder: 'Подредба',
  colour: 'Цвят',
  icon: 'Икона',
  tags: 'Етикети',
  pageCount: 'Брой страници',
  sizeBytes: 'Големина',
  versionNumber: 'Версия',
  deletedAt: 'Архивиран на',
  kioskTitle: 'Заглавие на панела',
  defaultLanguage: 'Език по подразбиране',
  syncIntervalMinutes: 'Синхронизация (мин.)',
  homeAfterIdleSeconds: 'Връщане към начало (сек.)',
  parentId: 'Подкатегория на',
  documentCount: 'Брой документи',
}

/** Values people recognise, instead of true/false/null and raw language codes. */
function showValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'да' : 'не'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—'
  if (key === 'language' || key === 'defaultLanguage') {
    const map: Record<string, string> = { bg: 'Български', en: 'Английски', both: 'И двата' }
    return map[String(value)] ?? String(value)
  }
  if (key === 'role') {
    const map: Record<string, string> = { admin: 'Администратор', editor: 'Редактор', viewer: 'Наблюдател' }
    return map[String(value)] ?? String(value)
  }
  if (key === 'sizeBytes') {
    const n = Number(value)
    return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Fields that are noise in a change list: identifiers and bookkeeping timestamps. */
const HIDDEN = new Set(['id', 'slug', 'createdAt', 'updatedAt', 'versionId', 'sha256', 'storedPath', 'passwordHash'])

type Change = { key: string; before: unknown; after: unknown }

function changes(before: unknown, after: unknown): Change[] {
  const a = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>
  const b = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).filter((k) => !HIDDEN.has(k))
  return keys
    .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .map((k) => ({ key: k, before: a[k], after: b[k] }))
}

/**
 * One expanded row. Three cases, all of which happen: a change with fields, a record that
 * only created or only removed something, and an action that touches no data at all.
 */
function Detail({ entry }: { entry: AuditEntry }) {
  const list = changes(entry.before, entry.after)
  const created = !entry.before && entry.after
  const removed = entry.before && !entry.after

  if (!entry.before && !entry.after) {
    return <p className="audit-detail__note">Това действие не променя данни — записано е само за проследимост.</p>
  }
  if (!list.length) {
    return <p className="audit-detail__note">Записът е запазен, но стойностите са същите — нищо не е било променено.</p>
  }
  return (
    <table className="audit-diff">
      <thead>
        <tr>
          <th>Поле</th>
          <th>{created ? 'Стойност' : 'Преди'}</th>
          {!created && <th>{removed ? '' : 'След'}</th>}
        </tr>
      </thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.key}>
            <th scope="row">{FIELDS[c.key] ?? c.key}</th>
            <td className={created ? '' : 'audit-diff__old'}>{showValue(c.key, created ? c.after : c.before)}</td>
            {!created && <td className="audit-diff__new">{removed ? '' : showValue(c.key, c.after)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function AuditPage() {
  const [filters, setFilters] = useState({ entity: '', actorId: '', from: '', to: '', page: 1 })
  const [open, setOpen] = useState<string | number | null>(null)
  const query = queryString(filters)
  const audit = useQuery({
    queryKey: ['audit', query],
    queryFn: () => api<AuditEntry[] | Paged<AuditEntry>>(`/api/audit${query}`),
    retry: false,
  })
  const entries = listFrom(audit.data)
  const total = !Array.isArray(audit.data) ? audit.data?.total : undefined

  return (
    <section className="page">
      <PageHeading title="Одит дневник" text="Пълна, неизменяема история на действията в системата." />

      <div className="toolbar">
        <select
          className="select filter-select"
          aria-label="Обект"
          value={filters.entity}
          onChange={(e) => setFilters((v) => ({ ...v, entity: e.target.value, page: 1 }))}
        >
          <option value="">Всички обекти</option>
          <option value="category">Категория</option>
          <option value="document">Документ</option>
          <option value="user">Потребител</option>
          <option value="device">Устройство</option>
          <option value="settings">Настройки</option>
        </select>
        <input
          className="input filter-select"
          placeholder="ID на извършител"
          aria-label="ID на извършител"
          value={filters.actorId}
          onChange={(e) => setFilters((v) => ({ ...v, actorId: e.target.value, page: 1 }))}
        />
        <label className="field field--date">
          <span className="field__hint">От дата</span>
          <input
            className="input"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((v) => ({ ...v, from: e.target.value, page: 1 }))}
          />
        </label>
        <label className="field field--date">
          <span className="field__hint">До дата</span>
          <input
            className="input"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((v) => ({ ...v, to: e.target.value, page: 1 }))}
          />
        </label>
        <Button variant="secondary" onClick={() => setFilters({ entity: '', actorId: '', from: '', to: '', page: 1 })}>
          <Icon name="refresh" /> Изчисти
        </Button>
      </div>

      <section className="card">
        {audit.isLoading ? (
          <div className="loading-lines">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : audit.isError ? (
          <ErrorState onRetry={() => audit.refetch()} />
        ) : entries.length ? (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th />
                    <th>Кога</th>
                    <th>Действие</th>
                    <th>Обект</th>
                    <th>Извършител</th>
                    <th>IP адрес</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <>
                      <tr key={entry.id}>
                        <td>
                          <button
                            className="icon-button"
                            aria-label="Покажи промени"
                            aria-expanded={open === entry.id}
                            onClick={() => setOpen(open === entry.id ? null : entry.id)}
                          >
                            <Icon name="chevron" />
                          </button>
                        </td>
                        <td>{formatDate(entry.at)}</td>
                        <td>
                          <strong>{entry.summary}</strong>
                          <br />
                          <span className="text-muted" title={entry.action}>
                            {ACTIONS[entry.action] ?? entry.action}
                          </span>
                        </td>
                        <td>
                          <span className="badge badge--muted">{ENTITIES[entry.entity] ?? entry.entity}</span>
                        </td>
                        <td>{entry.actorName || entry.actorType}</td>
                        <td className="mono">{entry.ip || '—'}</td>
                      </tr>
                      {open === entry.id && (
                        <tr className="audit-detail" key={`${entry.id}-detail`}>
                          <td colSpan={6}>
                            <Detail entry={entry} />
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
            <footer className="pagination">
              <span className="text-muted">{total !== undefined ? `${total} записа` : `Страница ${filters.page}`}</span>
              <Button variant="secondary" disabled={filters.page <= 1} onClick={() => setFilters((v) => ({ ...v, page: v.page - 1 }))}>
                Предишна
              </Button>
              <Button variant="secondary" disabled={entries.length === 0} onClick={() => setFilters((v) => ({ ...v, page: v.page + 1 }))}>
                Следваща
              </Button>
            </footer>
          </>
        ) : (
          <EmptyState
            icon="audit"
            title="Няма намерени записи"
            text="Променете филтрите или изчакайте нови действия в системата."
          />
        )}
      </section>
    </section>
  )
}
