import { Fragment, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, queryString } from '../api'
import { Button, ConfirmDialog, EmptyState, ErrorState, Icon, Modal, useToast } from '../components/ui'
import { formatBytes, formatDate, listFrom, PageHeading } from '../components/page'
import { useAuth } from '../auth'
import { uploadPdfs, validatePdf } from '../components/upload'
import type { ApiError, Category, Document, Language, Paged } from '../types'

const blank={categoryId:'',titleBg:'',titleEn:'',language:'bg' as Language,tags:[] as string[],sortOrder:0,pinned:false}
export function DocumentsPage(){const client=useQueryClient();const {toast}=useToast();const {user}=useAuth();
/* Only an administrator may remove a document, which is what the server enforces too. An
   editor sees no delete controls rather than controls that fail with 403 when used. */
const canDelete=user?.role==='admin';
/* Live documents or the archive. Archived documents were invisible before: the API could
   return them but nothing asked it to, so an archived document could be neither found nor
   restored without a database client. */
const [view,setView]=useState<'live'|'archive'>('live');
const [remove,setRemove]=useState<Document|null>(null);const [purge,setPurge]=useState<Document|null>(null);const [bulkDelete,setBulkDelete]=useState(false);
const [filters,setFilters]=useState({categoryId:'',language:'',q:''});const [search,setSearch]=useState('');const [upload,setUpload]=useState(false);const [selected,setSelected]=useState<string[]>([]);const [edit,setEdit]=useState<Document|null>(null);useEffect(()=>{const timer=window.setTimeout(()=>setFilters(prev=>({...prev,q:search})),250);return()=>window.clearTimeout(timer)},[search]);const cats=useQuery({queryKey:['categories'],queryFn:()=>api<Category[]|Paged<Category>>('/api/categories'),retry:false});const qs=queryString({...filters,deleted:view==='archive'?'only':'',page:1,pageSize:50});const docs=useQuery({queryKey:['documents',qs],queryFn:()=>api<Document[]|Paged<Document>>(`/api/documents${qs}`),retry:false});const invalidate=()=>client.invalidateQueries({queryKey:['documents']});const patch=useMutation({mutationFn:({id,data}:{id:string;data:Partial<Document>})=>api<Document>(`/api/documents/${id}`,{method:'PATCH',body:JSON.stringify(data)}),onSuccess:()=>{invalidate();setEdit(null);toast('Метаданните са запазени.')},onError:(e:ApiError)=>toast(e.message,'error')});/* Archiving takes the document off the panels and out of the list, and keeps every version
   and the audit trail. It is undone with Restore. */
const archive=useMutation({mutationFn:(id:string)=>api(`/api/documents/${id}`,{method:'DELETE'}),onSuccess:()=>{invalidate();setRemove(null);toast('Документът е архивиран и е свален от панелите.')},onError:(e:ApiError)=>toast(e.message,'error')});
/* Permanent deletion also removes the PDF files from the server's disk. Nothing brings it
   back, so it is only reachable from the archive, never from the live list in one step. */
const purgeDoc=useMutation({mutationFn:(id:string)=>api<{filesRemoved?:number}>(`/api/documents/${id}?hard=true`,{method:'DELETE'}),onSuccess:(r)=>{invalidate();setPurge(null);toast(`Документът е изтрит окончателно${r?.filesRemoved?` (${r.filesRemoved===1?'1 файл премахнат':`${r.filesRemoved} файла премахнати`} от диска)`:''}.`)},onError:(e:ApiError)=>toast(e.message,'error')});
const restore=useMutation({mutationFn:(id:string)=>api(`/api/documents/${id}/restore`,{method:'POST'}),onSuccess:()=>{invalidate();toast('Документът е върнат и ще се появи на панелите при следващата синхронизация.')},onError:(e:ApiError)=>toast(e.message,'error')});
const bulkArchive=useMutation({mutationFn:(ids:string[])=>Promise.all(ids.map(id=>api(`/api/documents/${id}`,{method:'DELETE'}))),onSuccess:()=>{invalidate();setSelected([]);setBulkDelete(false);toast('Избраните документи са архивирани.')},onError:(e:ApiError)=>toast(e.message,'error')});
const bulkMove=useMutation({mutationFn:(categoryId:string)=>Promise.all(selected.map(id=>api<Document>(`/api/documents/${id}`,{method:'PATCH',body:JSON.stringify({categoryId})}))),onSuccess:()=>{invalidate();setSelected([]);toast('Документите са преместени.')},onError:(e:ApiError)=>toast(e.message,'error')});const data=listFrom(docs.data);const categories=listFrom(cats.data);const toggle=(id:string)=>setSelected(prev=>prev.includes(id)?prev.filter(x=>x!==id):[...prev,id]);const archived=view==='archive';return <section className="page"><PageHeading title="Документи" text="Качвайте PDF документи и поддържайте актуални техните метаданни." action={<Button onClick={()=>setUpload(true)}><Icon name="upload"/> Качи документ</Button>}/><div className="toolbar"><div className="seg" role="group" aria-label="Изглед"><button type="button" className={`seg__btn ${archived?'':'seg__btn--on'}`} aria-pressed={!archived} onClick={()=>{setView('live');setSelected([])}}>Активни</button><button type="button" className={`seg__btn ${archived?'seg__btn--on':''}`} aria-pressed={archived} onClick={()=>{setView('archive');setSelected([])}}><Icon name="trash" size={16}/> Архив</button></div><div className="search-field"><Icon name="search"/><label className="sr-only" htmlFor="document-search">Търсене</label><input id="document-search" className="input" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Търсене по заглавие…"/></div><select className="select filter-select" aria-label="Категория" value={filters.categoryId} onChange={e=>setFilters(prev=>({...prev,categoryId:e.target.value}))}><option value="">Всички категории</option>{categories.map(c=><option key={c.id} value={c.id}>{c.nameBg}</option>)}</select><select className="select filter-select" aria-label="Език" value={filters.language} onChange={e=>setFilters(prev=>({...prev,language:e.target.value}))}><option value="">Всички езици</option><option value="bg">Български</option><option value="en">Английски</option><option value="both">Двуезичен</option></select></div>{archived&&<div className="warning-callout" style={{marginBottom:'1rem'}}><Icon name="alert"/><span>Архивираните документи не се показват на панелите. Върнете документ, за да се появи отново, или го изтрийте окончателно — тогава и PDF файловете се премахват от сървъра и това не може да бъде отменено.</span></div>}{selected.length>0&&<div className="warning-callout" style={{marginBottom:'1rem'}}><Icon name="documents"/><span>Избрани: <strong>{selected.length}</strong></span>{!archived&&<select className="select" aria-label="Премести в категория" defaultValue="" onChange={e=>{if(e.target.value)bulkMove.mutate(e.target.value)}} disabled={bulkMove.isPending}><option value="" disabled>Премести в категория…</option>{categories.map(c=><option key={c.id} value={c.id}>{c.nameBg}</option>)}</select>}{!archived&&canDelete&&<Button variant="danger" onClick={()=>setBulkDelete(true)} disabled={bulkArchive.isPending}><Icon name="trash"/> Архивирай избраните</Button>}<Button variant="quiet" onClick={()=>setSelected([])}>Откажи избора</Button></div>}<section className="card">{docs.isLoading?<div className="loading-lines"><span className="skeleton"/><span className="skeleton"/><span className="skeleton"/></div>:docs.isError?<ErrorState onRetry={()=>docs.refetch()}/>:data.length?<div className="table-wrap"><table className="data-table"><thead><tr><th><input type="checkbox" aria-label="Избери всички" checked={data.length>0&&selected.length===data.length} onChange={e=>setSelected(e.target.checked?data.map(d=>d.id):[])}/></th><th>Документ</th><th>Категория</th><th>Език</th><th>Версия</th><th>{archived?'Архивиран':'Обновен'}</th><th/></tr></thead><tbody>{data.map(doc=><Fragment key={doc.id}><tr><td><input type="checkbox" aria-label={`Избери ${doc.titleBg}`} checked={selected.includes(doc.id)} onChange={()=>toggle(doc.id)}/></td><td><Link to={`/documents/${doc.id}`}><strong>{doc.titleBg}</strong><br/><span className="text-muted">{doc.titleEn}</span></Link></td><td>{categories.find(c=>c.id===doc.categoryId)?.nameBg||'—'}</td><td><span className="badge badge--muted" style={{whiteSpace:'nowrap'}}>{doc.language==='bg'?'BG':doc.language==='en'?'EN':'BG / EN'}</span></td><td>v{doc.versionNumber}</td><td style={{whiteSpace:'nowrap'}}>{formatDate(archived&&doc.deletedAt?doc.deletedAt:doc.updatedAt,false)}</td><td><div className="actions">{archived?<><Button variant="secondary" onClick={()=>restore.mutate(doc.id)} disabled={restore.isPending}><Icon name="refresh"/> Върни</Button>{canDelete&&<button className="icon-button icon-button--danger" aria-label={`Изтрий окончателно ${doc.titleBg}`} title="Изтрий окончателно" onClick={()=>setPurge(doc)}><Icon name="trash"/></button>}</>:<><button className="icon-button" aria-label={`Редактирай ${doc.titleBg}`} onClick={()=>setEdit(doc)}><Icon name="edit"/></button><Link className="icon-button" aria-label={`Отвори ${doc.titleBg}`} to={`/documents/${doc.id}`}><Icon name="eye"/></Link>{canDelete&&<button className="icon-button icon-button--danger" aria-label={`Изтрий ${doc.titleBg}`} title="Изтрий документа" onClick={()=>setRemove(doc)}><Icon name="trash"/></button>}</>}</div></td></tr>{edit?.id===doc.id&&<tr><td colSpan={7}><MetadataInline document={doc} categories={categories} busy={patch.isPending} onClose={()=>setEdit(null)} onSave={details=>patch.mutate({id:doc.id,data:details})}/></td></tr>}</Fragment>)}</tbody></table></div>:(archived?<EmptyState icon="trash" title="Архивът е празен" text="Тук попадат документите, които са свалени от панелите. Нищо не е архивирано в момента."/>:<EmptyState icon="documents" title="Няма намерени документи" text="Качете първия PDF документ или променете филтрите." action={<Button onClick={()=>setUpload(true)}><Icon name="upload"/> Качи документ</Button>}/>)}</section>{upload&&<UploadDocument categories={categories} onClose={()=>setUpload(false)} onComplete={()=>{setUpload(false);invalidate();toast('Документът е качен.')}}/>}{remove&&<ConfirmDialog title="Архивиране на документ" confirmLabel="Архивирай" busy={archive.isPending} onClose={()=>setRemove(null)} onConfirm={()=>archive.mutate(remove.id)} message={<>«{remove.titleBg}» ще бъде свален от всички панели при следващата им синхронизация. Версиите и историята остават запазени и документът може да бъде върнат от раздел «Архив».</>}/>}{purge&&<PurgeDialog document={purge} busy={purgeDoc.isPending} onClose={()=>setPurge(null)} onConfirm={()=>purgeDoc.mutate(purge.id)}/>}{bulkDelete&&<ConfirmDialog title="Архивиране на избраните" confirmLabel={`Архивирай ${selected.length}`} busy={bulkArchive.isPending} onClose={()=>setBulkDelete(false)} onConfirm={()=>bulkArchive.mutate(selected)} message={<>{selected.length===1?'Документът ще бъде свален':`${selected.length} документа ще бъдат свалени`} от панелите. Историята остава запазена и всеки от тях може да бъде върнат от раздел «Архив».</>}/>}</section>}

/**
 * Permanent deletion, which is the one operation in the platform that destroys data.
 *
 * The title has to be typed out. A second «are you sure» is clicked through without being
 * read; copying the name of the document is the smallest thing that forces the right one to
 * be looked at, and these titles differ by a word or two.
 */
function PurgeDialog({document:doc,busy,onClose,onConfirm}:{document:Document;busy:boolean;onClose:()=>void;onConfirm:()=>void}){const [typed,setTyped]=useState('');const matches=typed.trim()===doc.titleBg.trim();return <Modal title="Окончателно изтриване" onClose={onClose}><div className="modal__body"><div className="warning-callout" style={{marginBottom:'1rem'}}><Icon name="alert"/><span>Това действие не може да бъде отменено. Всички версии на документа и PDF файловете им се премахват от сървъра. Записът в одитната следа остава.</span></div><div className="field"><label htmlFor="purge-confirm">За потвърждение напишете заглавието: <strong>{doc.titleBg}</strong></label><input id="purge-confirm" className="input" value={typed} onChange={e=>setTyped(e.target.value)} autoComplete="off" placeholder={doc.titleBg}/></div></div><footer className="modal__footer"><Button variant="secondary" onClick={onClose} disabled={busy}>Отказ</Button><Button variant="danger" onClick={onConfirm} disabled={busy||!matches}>{busy?'Изтриване…':'Изтрий окончателно'}</Button></footer></Modal>}
/**
 * A document is one policy, in up to two languages. Both files can be given here at once —
 * a policy published in Bulgarian and English is one entry, not two — and either may be
 * left empty and added later from the document's own page.
 */
function UploadDocument({categories,onClose,onComplete}:{categories:Category[];onClose:()=>void;onComplete:()=>void}){
  const {toast}=useToast()
  const [files,setFiles]=useState<{bg:File|null;en:File|null}>({bg:null,en:null})
  const [form,setForm]=useState(blank)
  const [progress,setProgress]=useState(0)
  const [duplicate,setDuplicate]=useState(false)
  const [busy,setBusy]=useState(false)

  const take=(lang:'bg'|'en')=>(candidate?:File)=>{
    if(!candidate)return
    const issue=validatePdf(candidate)
    if(issue){toast(issue,'error');return}
    setFiles(v=>({...v,[lang]:candidate}));setDuplicate(false)
  }

  const upload=async(allowDuplicate=false)=>{
    if(!files.bg&&!files.en){toast('Изберете поне един PDF файл.','error');return}
    setBusy(true)
    try{
      const payload:Record<string,File>={}
      if(files.bg)payload.fileBg=files.bg
      if(files.en)payload.fileEn=files.en
      await uploadPdfs('/api/documents'+(allowDuplicate?'?allowDuplicate=true':''),payload,{meta:form},setProgress)
      onComplete()
    }catch(error){
      const err=error as ApiError
      if(err.status===415&&err.code==='UNSUPPORTED_FILE_TYPE')toast('Файлът не е PDF и не може да бъде качен.','error')
      else if(err.status===409&&err.code==='DUPLICATE_CONTENT'){setDuplicate(true);toast('Открито е дублирано съдържание.','error')}
      else toast(err.message,'error')
    }finally{setBusy(false)}
  }

  const submit=(e:FormEvent)=>{e.preventDefault();upload(false)}

  return <Modal title="Качване на документ" wide onClose={onClose}><form onSubmit={submit}><div className="modal__body">
    <div className="dropzone-pair">
      <PdfDrop label="Български файл" file={files.bg} onPick={take('bg')}/>
      <PdfDrop label="Английски файл" file={files.en} onPick={take('en')}/>
    </div>
    <p className="text-muted" style={{marginTop:'.75rem'}}>
      Всеки език има собствена история на версиите. Ако единият липсва, документът се показва
      на панелите само на другия и може да бъде допълнен по-късно.
    </p>
    {busy&&<div className="upload-status"><span>Качване: {progress}%</span><div className="progress"><span style={{width:`${progress}%`}}/></div></div>}
    <div className="form-grid" style={{marginTop:'1.5rem'}}>
      <div className="field"><label htmlFor="titleBg">Заглавие на български</label><input id="titleBg" className="input" value={form.titleBg} onChange={e=>setForm(v=>({...v,titleBg:e.target.value}))} required/></div>
      <div className="field"><label htmlFor="titleEn">Заглавие на английски</label><input id="titleEn" className="input" value={form.titleEn} onChange={e=>setForm(v=>({...v,titleEn:e.target.value}))} required/></div>
      <div className="field"><label htmlFor="doc-category">Категория</label><select id="doc-category" className="select" value={form.categoryId} onChange={e=>setForm(v=>({...v,categoryId:e.target.value}))} required><option value="" disabled>Изберете категория</option>{categories.map(c=><option key={c.id} value={c.id}>{c.nameBg}</option>)}</select></div>
      <div className="field form-grid--full"><label htmlFor="tags">Етикети</label><input id="tags" className="input" placeholder="разделяйте с запетая" onChange={e=>setForm(v=>({...v,tags:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)}))}/></div>
    </div>
    {duplicate&&<div className="warning-callout" style={{marginTop:'1rem'}}><Icon name="alert"/><span>Същото съдържание вече съществува. Можете да продължите само ако това е умишлено.</span><Button type="button" variant="secondary" disabled={busy} onClick={()=>upload(true)}>Качи въпреки това</Button></div>}
  </div><footer className="modal__footer"><Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Отказ</Button><Button type="submit" disabled={busy}>{busy?'Качване…':'Качи документ'}</Button></footer></form></Modal>
}

/** One labelled drop target. Two of these sit side by side, one per language. */
function PdfDrop({label,file,onPick}:{label:string;file:File|null;onPick:(f?:File)=>void}){
  const input=useRef<HTMLInputElement>(null)
  const [dragging,setDragging]=useState(false)
  const id=`drop-${label}`
  return <div className="dropzone-slot">
    <span className="dropzone-slot__label">{label}</span>
    <input ref={input} id={id} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={e=>onPick(e.target.files?.[0])}/>
    <div className={`dropzone ${dragging?'dropzone--over':''} ${file?'dropzone--filled':''}`}
      onDragEnter={(e:DragEvent)=>{e.preventDefault();setDragging(true)}}
      onDragOver={e=>e.preventDefault()}
      onDragLeave={()=>setDragging(false)}
      onDrop={e=>{e.preventDefault();setDragging(false);onPick(e.dataTransfer.files[0])}}>
      <Icon name={file?'check':'upload'} size={30}/>
      <h3>{file?file.name:'Пуснете PDF файла тук'}</h3>
      <p>{file?formatBytes(file.size):'Само PDF, макс. 100 MB.'}</p>
      <Button type="button" variant="secondary" onClick={()=>input.current?.click()}>
        {file?'Смени файла':'Избери файл'}
      </Button>
    </div>
  </div>
}

function MetadataInline({document,categories,busy,onClose,onSave}:{document:Document;categories:Category[];busy:boolean;onClose:()=>void;onSave:(data:Partial<Document>)=>void}){const [form,setForm]=useState({titleBg:document.titleBg,titleEn:document.titleEn,categoryId:document.categoryId,language:document.language,tags:document.tags.join(', '),pinned:document.pinned});return <form className="inline-edit" onSubmit={e=>{e.preventDefault();onSave({...form,tags:form.tags.split(',').map(x=>x.trim()).filter(Boolean)})}}><div className="form-grid"><div className="field"><label htmlFor={`edit-titleBg-${document.id}`}>Заглавие на български</label><input id={`edit-titleBg-${document.id}`} className="input" value={form.titleBg} onChange={e=>setForm(v=>({...v,titleBg:e.target.value}))}/></div><div className="field"><label htmlFor={`edit-titleEn-${document.id}`}>Заглавие на английски</label><input id={`edit-titleEn-${document.id}`} className="input" value={form.titleEn} onChange={e=>setForm(v=>({...v,titleEn:e.target.value}))}/></div><div className="field"><label htmlFor={`edit-category-${document.id}`}>Категория</label><select id={`edit-category-${document.id}`} className="select" value={form.categoryId} onChange={e=>setForm(v=>({...v,categoryId:e.target.value}))}>{categories.map(c=><option key={c.id} value={c.id}>{c.nameBg}</option>)}</select></div><div className="field"><label>Език</label><p className="text-muted" style={{margin:'.5rem 0 0'}}>{document.language==='both'?'Български и английски':document.language==='en'?'Само английски':'Само български'} — следва качените файлове.</p></div><div className="field"><label htmlFor={`edit-tags-${document.id}`}>Етикети</label><input id={`edit-tags-${document.id}`} className="input" value={form.tags} onChange={e=>setForm(v=>({...v,tags:e.target.value}))}/></div><div className="switch-row"><label htmlFor={`pinned-${document.id}`}>Закрепен документ</label><label className="switch"><input id={`pinned-${document.id}`} type="checkbox" checked={form.pinned} onChange={e=>setForm(v=>({...v,pinned:e.target.checked}))}/><span/></label></div></div><div className="inline-edit__actions"><Button type="button" variant="secondary" onClick={onClose}>Отказ</Button><Button type="submit" disabled={busy}>{busy?'Запазване…':'Запази промените'}</Button></div></form>}
