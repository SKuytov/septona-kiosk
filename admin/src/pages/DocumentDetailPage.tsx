import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, fileUrl } from '../api'
import { useAuth } from '../auth'
import { Button, ConfirmDialog, EmptyState, ErrorState, Icon, Modal, useToast } from '../components/ui'
import { formatBytes, formatDate } from '../components/page'
import { uploadPdf, validatePdf } from '../components/upload'
import type { ApiError, DocFile, Document, Version } from '../types'

type Lang = 'bg' | 'en'
const LANGS: Lang[] = ['bg', 'en']
const LABEL: Record<Lang, string> = { bg: 'Български', en: 'Английски' }
const OF: Record<Lang, string> = { bg: 'българска', en: 'английска' }

/**
 * A document is one policy held in up to two languages. Each language is its own file with
 * its own history: replacing the Bulgarian PDF leaves the English one exactly as it was.
 * A language with no file yet can be filled either by uploading, or by joining a document
 * that was entered separately back when only one file per record was possible.
 */
export function DocumentDetailPage() {
  const { id = '' } = useParams()
  const client = useQueryClient()
  const { user } = useAuth()
  const { toast } = useToast()
  const navigate = useNavigate()

  const [uploadFor, setUploadFor] = useState<Lang | null>(null)
  const [linkFor, setLinkFor] = useState<Lang | null>(null)
  const [restore, setRestore] = useState<Version | null>(null)
  const [unlink, setUnlink] = useState<Lang | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)

  const doc = useQuery({
    queryKey: ['document', id],
    queryFn: () => api<Document>(`/api/documents/${id}`),
    enabled: !!id,
    retry: false,
  })

  const refresh = () => client.invalidateQueries({ queryKey: ['document', id] })

  /* Archiving from here leaves nowhere to stand — the document is gone from the list this
     page belongs to — so it returns to the list, where the Archive view holds it. */
  const archiveDoc = useMutation({
    mutationFn: () => api(`/api/documents/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['documents'] })
      toast('Документът е архивиран и е свален от панелите.')
      navigate('/documents')
    },
    onError: (e: ApiError) => toast(e.message, 'error'),
  })

  const restoreMutation = useMutation({
    mutationFn: (version: Version) =>
      api(`/api/documents/${id}/versions/${version.id}/restore`, { method: 'POST' }),
    onSuccess: (_d, version) => {
      refresh(); setRestore(null)
      toast(`Версия ${version.versionNumber} е текуща за ${OF[version.language || 'bg']} версия.`)
    },
    onError: (e: ApiError) => toast(e.message, 'error'),
  })

  const unlinkMutation = useMutation({
    mutationFn: (lang: Lang) =>
      api(`/api/documents/${id}/unlink-language?language=${lang}`, { method: 'POST' }),
    onSuccess: (_d, lang) => {
      refresh(); client.invalidateQueries({ queryKey: ['documents'] }); setUnlink(null)
      toast(`${LABEL[lang]}ят файл вече е отделен документ.`)
    },
    onError: (e: ApiError) => toast(e.message, 'error'),
  })

  if (doc.isLoading) return (
    <section className="page">
      <div className="loading-lines"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>
    </section>
  )
  if (doc.isError || !doc.data) return (
    <section className="page"><ErrorState onRetry={() => doc.refetch()} /></section>
  )

  const item = doc.data
  const versions = item.versions || []
  // A document saved before the two-file model reports no `files`; treat its single file as
  // the Bulgarian one so this page still works against an older server.
  const files: Record<Lang, DocFile | null> = item.files ?? {
    bg: item.versionId
      ? { versionId: item.versionId, versionNumber: item.versionNumber, sizeBytes: item.sizeBytes }
      : null,
    en: null,
  }
  const present = LANGS.filter((l) => files[l])
  const canEdit = user?.role === 'admin' || user?.role === 'editor'
  const canDelete = user?.role === 'admin'

  const summary = present.length === 2 ? 'български и английски'
    : present.length === 1 ? `само ${present[0] === 'bg' ? 'български' : 'английски'}`
    : 'няма качен файл'

  return (
    <section className="page">
      <Link to="/documents" className="button button--quiet"><Icon name="arrow" /> Назад към документите</Link>

      <div className="page-heading" style={{ marginTop: '1rem' }}>
        <div>
          <h1>{item.titleBg}</h1>
          <p>{item.titleEn || '—'} · {summary}</p>
        </div>
        <div className="actions">
          {canDelete && (
            <Button variant="secondary" onClick={() => setArchiveOpen(true)}>
              <Icon name="trash" /> Архивирай
            </Button>
          )}
        </div>
      </div>

      {/* One card per language, side by side, so it is obvious at a glance which of the two
          is missing. */}
      <div className="content-grid content-grid--even">
        {LANGS.map((lang) => {
          const file = files[lang]
          const chain = versions.filter((v) => (v.language || 'bg') === lang)
          return (
            <section className="card" key={lang}>
              <header className="card__header">
                <h2>{LABEL[lang]} файл</h2>
                {file && (
                  <div className="actions">
                    <a className="button button--quiet"
                       href={fileUrl(`/api/documents/${id}/versions/${file.versionId}/file`)}
                       target="_blank" rel="noreferrer">
                      <Icon name="eye" /> Отвори
                    </a>
                    <a className="button button--quiet"
                       href={fileUrl(`/api/documents/${id}/versions/${file.versionId}/file?download=1`)}>
                      <Icon name="download" /> Изтегли
                    </a>
                  </div>
                )}
              </header>

              {file ? (
                <>
                  <iframe
                    className="preview"
                    title={`Преглед на ${item.titleBg} — ${LABEL[lang]}`}
                    src={fileUrl(`/api/documents/${id}/versions/${file.versionId}/file`)}
                  />
                  <div className="card__body">
                    <p className="text-muted">
                      Версия {file.versionNumber} · {formatBytes(file.sizeBytes)}
                      {chain.length > 1 && ` · ${chain.length} версии в историята`}
                    </p>
                    {canEdit && (
                      <div className="actions" style={{ marginTop: '.75rem' }}>
                        <Button onClick={() => setUploadFor(lang)}>
                          <Icon name="upload" /> Качи нова версия
                        </Button>
                        {present.length === 2 && (
                          <Button variant="secondary" onClick={() => setUnlink(lang)}>
                            Отдели като отделен документ
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="card__body">
                  <EmptyState
                    title={`Няма ${LABEL[lang].toLowerCase()} файл`}
                    text={lang === 'en'
                      ? 'Документът се показва на панелите само на български, докато не бъде качен английски файл.'
                      : 'Документът се показва на панелите само на английски, докато не бъде качен български файл.'}
                  />
                  {canEdit && (
                    <div className="actions" style={{ marginTop: '.75rem' }}>
                      <Button onClick={() => setUploadFor(lang)}>
                        <Icon name="upload" /> Качи {LABEL[lang].toLowerCase()} файл
                      </Button>
                      <Button variant="secondary" onClick={() => setLinkFor(lang)}>
                        Свържи съществуващ документ
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </section>
          )
        })}
      </div>

      {/* History, one chain per language. Every entry can be opened or downloaded on the
          spot — restoring is only needed to change what the panels show. */}
      <div className="content-grid content-grid--even" style={{ marginTop: '1.5rem' }}>
        {LANGS.map((lang) => {
          const chain = versions
            .filter((v) => (v.language || 'bg') === lang)
            .sort((a, b) => (b.versionNumber || 0) - (a.versionNumber || 0))
          return (
            <section className="card" key={lang}>
              <header className="card__header"><h2>История — {LABEL[lang].toLowerCase()}</h2></header>
              <div className="card__body">
                {chain.length ? (
                  <div className="timeline">
                    {chain.map((version) => {
                      const isCurrent = version.id === files[lang]?.versionId
                      return (
                        <article key={version.id} className="timeline-item">
                          <div className="timeline-item__top">
                            <div>
                              <strong>
                                Версия {version.versionNumber ?? '—'}{' '}
                                {isCurrent && <span className="badge badge--ok">Текуща</span>}
                              </strong>
                              <p className="text-muted">
                                {formatDate(version.createdAt || version.uploadedAt)} ·{' '}
                                <span style={{ whiteSpace: 'nowrap' }}>{formatBytes(version.sizeBytes)}</span>
                              </p>
                            </div>
                            <div className="actions">
                              <a className="button button--quiet"
                                 href={fileUrl(`/api/documents/${id}/versions/${version.id}/file`)}
                                 target="_blank" rel="noreferrer">
                                <Icon name="eye" /> Виж
                              </a>
                              <a className="button button--quiet"
                                 href={fileUrl(`/api/documents/${id}/versions/${version.id}/file?download=1`)}>
                                <Icon name="download" /> Изтегли
                              </a>
                              {canEdit && !isCurrent && (
                                <Button variant="secondary" onClick={() => setRestore(version)}>
                                  <Icon name="refresh" /> Възстанови
                                </Button>
                              )}
                            </div>
                          </div>
                          <p style={{ marginTop: '.5rem' }}>{version.note || 'Без бележка към версията.'}</p>
                          <p className="text-muted" style={{ marginTop: '.25rem' }}>
                            Качено от: {version.uploaderName || version.uploader?.name || '—'}
                          </p>
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <EmptyState title="Няма версии" text={`Тук ще се покаже историята на ${OF[lang]} версия.`} />
                )}
              </div>
            </section>
          )
        })}
      </div>

      {uploadFor && (
        <UploadVersion
          documentId={id}
          language={uploadFor}
          isFirst={!files[uploadFor]}
          onClose={() => setUploadFor(null)}
          onComplete={() => {
            const lang = uploadFor
            setUploadFor(null); refresh(); client.invalidateQueries({ queryKey: ['documents'] })
            toast(files[lang] ? `Новата ${OF[lang]} версия е качена.`
              : `${LABEL[lang]}ят файл е качен.`)
          }}
        />
      )}

      {linkFor && (
        <LinkLanguage
          documentId={id}
          language={linkFor}
          categoryId={item.categoryId}
          onClose={() => setLinkFor(null)}
          onComplete={() => {
            setLinkFor(null); refresh(); client.invalidateQueries({ queryKey: ['documents'] })
            toast('Документите са свързани.')
          }}
        />
      )}

      {restore && (
        <ConfirmDialog
          title="Възстановяване на версия"
          message={<>Версия {restore.versionNumber ?? ''} ще стане текущата {OF[restore.language || 'bg']} версия.
            Досегашната остава в историята, а другият език не се променя.</>}
          confirmLabel="Възстанови версията"
          destructive={false}
          busy={restoreMutation.isPending}
          onClose={() => setRestore(null)}
          onConfirm={() => restoreMutation.mutate(restore)}
        />
      )}

      {unlink && (
        <ConfirmDialog
          title="Отделяне на език"
          message={<>{LABEL[unlink]}ят файл и цялата му история ще станат отделен документ.
            «{item.titleBg}» остава само с {unlink === 'bg' ? 'английския' : 'българския'} файл.</>}
          confirmLabel="Отдели"
          destructive={false}
          busy={unlinkMutation.isPending}
          onClose={() => setUnlink(null)}
          onConfirm={() => unlinkMutation.mutate(unlink)}
        />
      )}

      {archiveOpen && (
        <ConfirmDialog
          title="Архивиране на документ"
          confirmLabel="Архивирай"
          busy={archiveDoc.isPending}
          onClose={() => setArchiveOpen(false)}
          onConfirm={() => archiveDoc.mutate()}
          message={<>«{item.titleBg}» ще бъде свален от всички панели при следващата им синхронизация.
            Всички {versions.length} {versions.length === 1 ? 'версия' : 'версии'} и историята остават запазени,
            а документът може да бъде върнат от раздел «Архив» в списъка с документи.</>}
        />
      )}
    </section>
  )
}

function UploadVersion({ documentId, language, isFirst, onClose, onComplete }: {
  documentId: string; language: Lang; isFirst: boolean; onClose: () => void; onComplete: () => void
}) {
  const { toast } = useToast()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)

  const select = (candidate?: File) => {
    if (!candidate) return
    const issue = validatePdf(candidate)
    if (issue) { toast(issue, 'error'); return }
    setFile(candidate)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!file) { toast('Изберете PDF файл за качване.', 'error'); return }
    setBusy(true)
    try {
      await uploadPdf(`/api/documents/${documentId}/versions?language=${language}`,
        file, { note }, setProgress)
      onComplete()
    } catch (error) {
      const err = error as ApiError
      if (err.status === 415 && err.code === 'UNSUPPORTED_FILE_TYPE')
        toast('Файлът не е PDF и не може да бъде качен.', 'error')
      else toast(err.message, 'error')
    } finally { setBusy(false) }
  }

  return (
    <Modal title={isFirst ? `Качване на ${LABEL[language].toLowerCase()} файл`
      : `Нова ${OF[language]} версия`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal__body">
          <p className="text-muted" style={{ marginBottom: '1rem' }}>
            Файлът се качва като {LABEL[language].toLowerCase()} версия. Другият език остава непроменен.
          </p>
          <input ref={input} className="sr-only" type="file" accept="application/pdf,.pdf"
                 onChange={(e) => select(e.target.files?.[0])} />
          <div className={`dropzone ${dragging ? 'dropzone--over' : ''}`}
               onDragEnter={(e: DragEvent) => { e.preventDefault(); setDragging(true) }}
               onDragOver={(e) => e.preventDefault()}
               onDragLeave={() => setDragging(false)}
               onDrop={(e) => { e.preventDefault(); setDragging(false); select(e.dataTransfer.files[0]) }}>
            <Icon name="upload" size={34} />
            <h3>{file ? file.name : 'Пуснете PDF файла тук'}</h3>
            <p>Приемат се само PDF файлове (макс. 100 MB).</p>
            <Button type="button" variant="secondary" onClick={() => input.current?.click()}>Избери файл</Button>
          </div>
          {busy && (
            <div className="upload-status">
              <span>Качване: {progress}%</span>
              <div className="progress"><span style={{ width: `${progress}%` }} /></div>
            </div>
          )}
          <div className="field" style={{ marginTop: '1.25rem' }}>
            <label htmlFor="version-note">Бележка към версията</label>
            <textarea id="version-note" className="textarea" value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Напр. Актуализация след годишен преглед" />
          </div>
        </div>
        <footer className="modal__footer">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Отказ</Button>
          <Button type="submit" disabled={busy}>{busy ? 'Качване…' : 'Качи файла'}</Button>
        </footer>
      </form>
    </Modal>
  )
}

/**
 * Join a document that holds only the missing language. This is how the pairs that were
 * entered as two separate records get put back together, and the automatic merge run at
 * upgrade time deliberately left the doubtful ones for a person to decide here.
 */
function LinkLanguage({ documentId, language, categoryId, onClose, onComplete }: {
  documentId: string; language: Lang; categoryId: string; onClose: () => void; onComplete: () => void
}) {
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  const list = useQuery({
    queryKey: ['link-candidates', language, query],
    queryFn: () => api<{ documents: Document[] }>(
      `/api/documents?language=${language}&pageSize=50&q=${encodeURIComponent(query)}`),
  })

  const link = useMutation({
    mutationFn: () => api(`/api/documents/${documentId}/link-language`, {
      method: 'POST', body: JSON.stringify({ sourceDocumentId: chosen }),
    }),
    onSuccess: onComplete,
    onError: (e: ApiError) => toast(e.message, 'error'),
  })

  // Only a document holding just this language can be joined; anything with both files of
  // its own would lose one, and the server refuses it anyway.
  const other: Lang = language === 'bg' ? 'en' : 'bg'
  const candidates = (list.data?.documents || [])
    .filter((d) => d.id !== documentId && !d.deletedAt)
    .filter((d) => !d.files || (d.files[language] && !d.files[other]))
    // The same category first: a translation almost always lives beside its original.
    .sort((a, b) => Number(b.categoryId === categoryId) - Number(a.categoryId === categoryId))

  return (
    <Modal title={`Свързване на ${OF[language]} версия`} onClose={onClose}>
      <div className="modal__body">
        <p className="text-muted">
          Изберете документа, който съдържа {OF[language]} версия. Неговият файл и историята му
          ще преминат тук, а самият той ще бъде архивиран.
        </p>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="link-search">Търсене по заглавие</label>
          <input id="link-search" className="input" value={query} autoFocus
                 onChange={(e) => setQuery(e.target.value)} placeholder="Напр. Политика по качеството" />
        </div>
        <div style={{ maxHeight: '17rem', overflowY: 'auto', marginTop: '.75rem' }}>
          {list.isLoading && <p className="text-muted">Зареждане…</p>}
          {!list.isLoading && !candidates.length && (
            <p className="text-muted">Няма подходящи документи.</p>
          )}
          {candidates.map((d) => (
            <label key={d.id} className="pick-row">
              <input type="radio" name="link-target" value={d.id}
                     checked={chosen === d.id} onChange={() => setChosen(d.id)} />
              <span>
                <strong>{d.titleBg}</strong>
                {d.titleEn && <span className="text-muted"> · {d.titleEn}</span>}
              </span>
            </label>
          ))}
        </div>
      </div>
      <footer className="modal__footer">
        <Button type="button" variant="secondary" onClick={onClose} disabled={link.isPending}>Отказ</Button>
        <Button type="button" disabled={!chosen || link.isPending} onClick={() => link.mutate()}>
          {link.isPending ? 'Свързване…' : 'Свържи'}
        </Button>
      </footer>
    </Modal>
  )
}
