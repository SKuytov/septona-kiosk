import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import logo from './assets/septona-logo.jpg';
import { Icon } from './components/Icon';
import { DocCard } from './components/DocCard';
import { SearchOverlay } from './components/SearchOverlay';
/*
  The viewer, and with it the PDF engine, is fetched separately from the rest of the app.

  The engine is by far the largest thing in the build, and while it was part of the main
  bundle the panel could not show anything at all until it had been downloaded, parsed and
  evaluated — which is paid for on every restart, and this panel restarts often. It is now
  fetched as soon as the list is up and the panel is idle, so the list appears sooner and a
  document still opens immediately.
*/
/** Long enough for the list to be painted first, short enough to be ready before a tap. */
const VIEWER_WARM_MS = 700;
const loadViewer = () => import('./components/PdfViewer');
const PdfViewer = lazy(() => loadViewer().then((m) => ({ default: m.PdfViewer })));
import { PinPad, ServiceScreen } from './components/ServiceScreen';
import { t, plural, formatDate } from './lib/i18n';
import { catName, matchesLang, DEFAULT_SETTINGS } from './lib/types';
import type { Doc, Lang, Manifest, SyncState } from './lib/types';
import { emptyState, getConnection, getLastSync, sync as runSync } from './lib/sync';
import { listFileIds, loadManifest, metaGet, metaSet, requestPersistence } from './lib/store';
import { importSeed } from './lib/seed';
import { useHoldGesture } from './lib/useHoldGesture';
import { useMediaQuery, SPLIT_QUERY } from './lib/useMediaQuery';

type Screen = 'boot' | 'browse' | 'service';

export default function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lang, setLang] = useState<Lang>('bg');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  const [searching, setSearching] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Non-null while the bundled document set is being imported on first launch.
  const [seeding, setSeeding] = useState<{ done: number; total: number } | null>(null);
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [syncState, setSyncState] = useState<SyncState>(emptyState());
  const [clock, setClock] = useState(new Date());

  /**
   * Reading layout.
   *
   * Wide enough (the wall panel in portrait, or a tablet) and the document opens beside the
   * list, so moving between documents costs one tap instead of back-then-forward. A phone
   * stays with the full-screen reader, where a split would leave both halves too narrow.
   */
  const split = useMediaQuery(SPLIT_QUERY);
  /** Pane layout: the list is hidden to give the page the full width. */
  const [listHidden, setListHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Auto-cycle bookkeeping
  const [cycling, setCycling] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const lastTouch = useRef<number>(0);

  const settings = manifest?.settings ?? DEFAULT_SETTINGS;

  // ------------------------------------------------------------ initial load
  useEffect(() => {
    void (async () => {
      const [stored, conn, savedLang, last] = await Promise.all([
        loadManifest(),
        getConnection(),
        metaGet<Lang>('lang'),
        getLastSync(),
      ]);

      // Copy the documents embedded in the APK into IndexedDB so the board is usable
      // before anyone configures a server.
      //
      // Always ask: importSeed decides for itself whether there is anything to do. It
      // refuses once the panel has synced with a server, and it re-imports when the
      // local copy came from an older, unvalidated import. Progress only arrives once
      // real work starts, so a normal boot shows no import step at all.
      let m = stored;
      const seeded = await importSeed((p) => setSeeding(p));
      if (seeded) m = seeded;
      setSeeding(null);

      const ids = await listFileIds();
      if (m) {
        setManifest(m);
        setLang(savedLang || m.settings.defaultLanguage || 'bg');
        setSyncState((s) => ({
          ...s,
          status: 'idle',
          lastSyncAt: last ?? null,
          manifestVersion: m.manifestVersion,
          cachedCount: ids.length,
        }));
      } else if (savedLang) {
        setLang(savedLang);
      }
      setCachedIds(new Set(ids));
      setConfigured(!!(conn?.baseUrl && conn?.deviceKey));
      void requestPersistence();
      // Brief splash so the panel never flashes an empty frame on power-up. Seeding
      // has already finished by this point, so no extra delay is needed for it.
      setTimeout(() => setScreen('browse'), m ? 500 : 900);
    })();
  }, []);

  useEffect(() => { void metaSet('lang', lang); }, [lang]);

  // ------------------------------------------------------------------ syncing
  const doSync = useCallback(async () => {
    const res = await runSync((partial) => setSyncState((s) => ({ ...s, ...partial })));
    if (res.manifest) setManifest(res.manifest);
    setCachedIds(new Set(await listFileIds()));
  }, []);

  useEffect(() => {
    if (configured !== true) return;
    void doSync();
    const minutes = Math.max(1, settings.syncIntervalMinutes || 15);
    const timer = setInterval(() => void doSync(), minutes * 60_000);
    const onOnline = () => void doSync();
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [configured, settings.syncIntervalMinutes, doSync]);

  // Declared before every effect that lists it as a dependency: a dependency array
  // is evaluated during render, so a later `const` would be in the temporal dead
  // zone and throw "Cannot access 'noteActivity' before initialization".
  /*
    Fetch the viewer chunk once the list is on screen. Waiting for the reader to tap a
    document would make the first open wait for a 400KB download and parse; doing it here
    means the list appears without it and the document is ready by the time anyone asks.
  */
  useEffect(() => {
    const id = window.setTimeout(() => void loadViewer().catch(() => {}), VIEWER_WARM_MS);
    return () => clearTimeout(id);
  }, []);

  const noteActivity = useCallback(() => {
    lastTouch.current = Date.now();
    setCycling(false);
    setElapsed(0);
  }, []);

  // ------------------------------------------------- hardware back button (APK)
  // MainActivity forwards Android's back press here instead of finishing the
  // activity, so back closes the topmost layer and never exits the kiosk.
  useEffect(() => {
    const onBack = () => {
      if (pinOpen) setPinOpen(false);
      else if (openDoc) setOpenDoc(null);
      else if (searching) setSearching(false);
      else if (screen === 'service') setScreen('browse');
      noteActivity();
    };
    window.addEventListener('kioskBack', onBack);
    return () => window.removeEventListener('kioskBack', onBack);
  }, [pinOpen, openDoc, searching, screen, noteActivity]);

  // -------------------------------------------------------------------- clock
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // ---------------------------------------------------- derived content model
  const categories = useMemo(() => {
    if (!manifest) return [];
    // Only categories that actually have something to show in the active language,
    // so auto-cycling never lands on a blank screen.
    return manifest.categories
      .filter((c) => c.visible)
      .filter((c) => manifest.documents.some((d) => d.categoryId === c.id && matchesLang(d, lang)))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [manifest, lang]);

  const docsByCat = useMemo(() => {
    const map = new Map<string, Doc[]>();
    if (!manifest) return map;
    for (const d of manifest.documents) {
      if (!matchesLang(d, lang)) continue;
      const arr = map.get(d.categoryId) || [];
      arr.push(d);
      map.set(d.categoryId, arr);
    }
    for (const arr of map.values()) {
      arr.sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          a.sortOrder - b.sortOrder ||
          a.titleBg.localeCompare(b.titleBg, 'bg')
      );
    }
    return map;
  }, [manifest, lang]);

  // Keep the selection valid as language filters change the category set.
  useEffect(() => {
    if (!categories.length) {
      if (activeCat !== null) setActiveCat(null);
      return;
    }
    if (!activeCat || !categories.some((c) => c.id === activeCat)) {
      setActiveCat(categories[0].id);
      setElapsed(0);
    }
  }, [categories, activeCat]);

  const activeIndex = Math.max(0, categories.findIndex((c) => c.id === activeCat));
  const current = categories[activeIndex];
  const currentDocs = current ? docsByCat.get(current.id) || [] : [];
  const cycleSeconds = Math.max(5, current?.cycleSeconds || settings.cycleSeconds || 45);

  // ------------------------------------------------------------- auto-cycling
  const busy = searching || !!openDoc || screen !== 'browse' || pinOpen;

  // Any touch anywhere counts as activity and pauses the carousel.
  useEffect(() => {
    const handler = () => noteActivity();
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [noteActivity]);

  // One second heartbeat drives both advancing and idle-resume.
  useEffect(() => {
    if (!settings.cycleEnabled || categories.length < 2) return;
    const timer = setInterval(() => {
      // Resume after the configured idle period, but never while the user is
      // reading a document or searching.
      if (!cycling) {
        const idleFor = (Date.now() - lastTouch.current) / 1000;
        if (!busy && lastTouch.current > 0 && idleFor >= (settings.idleResumeSeconds || 90)) {
          setCycling(true);
          setElapsed(0);
        }
        return;
      }
      if (busy) return;
      setElapsed((e) => {
        if (e + 1 >= cycleSeconds) {
          setActiveCat((currentId) => {
            const idx = categories.findIndex((c) => c.id === currentId);
            return categories[(idx + 1) % categories.length].id;
          });
          return 0;
        }
        return e + 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cycling, busy, categories, cycleSeconds, settings.cycleEnabled, settings.idleResumeSeconds]);

  const pickCategory = (catId: string) => {
    setActiveCat(catId);
    setElapsed(0);
    noteActivity();
  };

  // -------------------------------------------------- hidden service gesture
  // The timing, the touch handling and the tap fallback live in the hook; see the notes
  // there for why plain pointer events on the logo image never worked on the device.
  const openService = useCallback(() => setPinOpen(true), []);
  const hold = useHoldGesture(openService, 3000);

  // ----------------------------------------------------------- layout guards
  // Collapsing the list and full screen only exist in the split layout. Leaving either set
  // while the window narrows to a phone would hide the list with nothing able to bring it
  // back, so both are dropped as soon as the split does.
  useEffect(() => {
    if (!split) {
      setListHidden(false);
      setFullscreen(false);
    }
  }, [split]);

  // Closing a document also leaves full screen: otherwise the board itself would come back
  // with the header and category rail still hidden.
  useEffect(() => {
    if (!openDoc) setFullscreen(false);
  }, [openDoc]);

  // ------------------------------------------------------------------- render
  if (screen === 'boot') {
    return (
      <div className="boot">
        <img className="boot__logo" src={logo} alt="Septona" />
        <div className="boot__bar"><i /></div>
        <div className="boot__txt">
          {seeding
            ? `${t(lang, 'preparing')} ${seeding.done}/${seeding.total}`
            : t(lang, 'loading')}
        </div>
      </div>
    );
  }

  if (screen === 'service') {
    return (
      <ServiceScreen
          lang={lang}
          sync={syncState}
          onSyncNow={() => void doSync()}
          onClose={() => {
            setScreen('browse');
            void (async () => {
              const conn = await getConnection();
              setConfigured(!!(conn?.baseUrl && conn?.deviceKey));
            })();
          }}
      />
    );
  }

  const syncDot =
    syncState.status === 'downloading' || syncState.status === 'checking'
      ? 'sync__dot--busy'
      : syncState.status === 'offline'
        ? 'sync__dot--off'
        : syncState.status === 'error'
          ? 'sync__dot--err'
          : '';

  const syncLabel =
    syncState.status === 'downloading'
      ? `${t(lang, 'syncing')} ${syncState.progressDone}/${syncState.progressTotal}`
      : syncState.status === 'checking'
        ? t(lang, 'syncing')
        : syncState.status === 'offline'
          ? t(lang, 'offline')
          : configured === false
            // A seeded panel is showing the set bundled in the APK: it is not
            // misconfigured, it just has no server yet.
            ? t(lang, manifest ? 'localContent' : 'notConfigured')
            : t(lang, 'synced');

  const totalDocs = manifest ? manifest.documents.filter((d) => matchesLang(d, lang)).length : 0;

  /**
   * Whether the board and a document are on screen together.
   *
   * The split only appears once something is open. With nothing open the panel is an attract
   * screen cycling through the categories, and that wants the full width for the grid rather
   * than two thirds of it reserved for an empty reading pane.
   */
  const splitOpen = split && !!openDoc;

  return (
    // While a document is open the header and category rail give up some of their height to
    // the page: see `.app--reading` in app.css. On a tablet in portrait they were taking a
    // third of the screen before the document even started.
    <div className={`app ${splitOpen ? 'app--reading' : ''}`}>
      <header className="hdr">
        {/*
          The gesture is bound to this wrapper, not to the image. Android WebView runs its
          own long-press behaviour over an <img> — the selection callout and image drag — and
          when it takes the gesture over it cancels ours. The wrapper suppresses all of that
          in CSS and the image is made transparent to pointer events. The listeners are bound
          natively by the hook, not through React props, because React's touch listeners are
          passive and cannot preventDefault.

          The ring is deliberate feedback: an invisible gesture that fails is impossible to
          tell apart from a broken build, which is exactly how this was first reported.
        */}
        <span
          className="hdr__logo-hit"
          role="button"
          tabIndex={-1}
          aria-label={t(lang, 'service')}
          ref={hold.ref}
        >
          <img className="hdr__logo" src={logo} alt="Septona" draggable={false} />
          {hold.progress > 0 && (
            <span className="hdr__hold" aria-hidden="true">
              <span className="hdr__hold-bar" style={{ width: `${hold.progress * 100}%` }} />
            </span>
          )}
        </span>

        <div className="hdr__titles">
          <div className="hdr__title">{settings.kioskTitle}</div>
          <div className="hdr__sub">
            <span>
              {totalDocs} {plural(lang, totalDocs)} · {categories.length}{' '}
              {lang === 'bg' ? 'категории' : 'categories'}
            </span>
            {syncState.lastSyncAt && (
              <span>· {t(lang, 'lastSync')}: {formatDate(syncState.lastSyncAt, lang)}</span>
            )}
          </div>
        </div>

        <div className="hdr__actions">
          <span className="sync" title={syncState.message || ''}>
            <span className={`sync__dot ${syncDot}`} />
            <span>{syncLabel}</span>
          </span>

          <div className="lang" role="group" aria-label="Language">
            <button
              className={`lang__b ${lang === 'bg' ? 'lang__b--on' : ''}`}
              onClick={() => { setLang('bg'); noteActivity(); }}
            >
              БГ
            </button>
            <button
              className={`lang__b ${lang === 'en' ? 'lang__b--on' : ''}`}
              onClick={() => { setLang('en'); noteActivity(); }}
            >
              EN
            </button>
          </div>

          <button className="hbtn" onClick={() => { setSearching(true); noteActivity(); }}>
            <Icon name="searchGlass" size={22} />
            <span>{t(lang, 'search')}</span>
          </button>
        </div>

        <div className="hdr__clock">
          <div className="hdr__time">
            {clock.toLocaleTimeString(lang === 'bg' ? 'bg-BG' : 'en-GB', {
              hour: '2-digit', minute: '2-digit',
            })}
          </div>
          <div className="hdr__date">
            {clock.toLocaleDateString(lang === 'bg' ? 'bg-BG' : 'en-GB', {
              day: '2-digit', month: 'short', year: 'numeric',
            })}
          </div>
        </div>
      </header>

      {categories.length > 0 && (
        <nav className="rail">
          {categories.map((c) => {
            const on = c.id === activeCat;
            const count = (docsByCat.get(c.id) || []).length;
            return (
              <button
                key={c.id}
                className={`tab ${on ? 'tab--on' : ''}`}
                style={{ ['--tab-accent' as string]: c.colour }}
                onClick={() => pickCategory(c.id)}
              >
                <Icon name={c.icon} size={22} style={{ color: on ? c.colour : undefined }} />
                <span>{catName(c, lang)}</span>
                <span className="tab__count">{count}</span>
                {on && cycling && settings.cycleEnabled && categories.length > 1 && (
                  <span className="tab__prog" style={{ width: `${(elapsed / cycleSeconds) * 100}%` }} />
                )}
              </button>
            );
          })}

          <span className="rail__spacer" />

          {categories.length > 1 && settings.cycleEnabled && (
            <button
              className={`cyc ${cycling ? '' : 'cyc--off'}`}
              onClick={() => {
                if (cycling) { setCycling(false); lastTouch.current = Date.now(); }
                else { setCycling(true); setElapsed(0); lastTouch.current = 0; }
              }}
            >
              <Icon name={cycling ? 'pause' : 'play'} size={20} />
              <span>
                {cycling
                  ? `${t(lang, 'autoCycle')} · ${Math.max(0, cycleSeconds - elapsed)}${t(lang, 'seconds')}`
                  : t(lang, 'paused')}
              </span>
            </button>
          )}
        </nav>
      )}

      <main
        className={[
          'main',
          splitOpen ? 'main--split' : '',
          splitOpen && listHidden ? 'main--nolist' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {/*
          The list is always this same markup. In the split layout it becomes the left column
          and the cards fall to a single compact row each; nothing about it is rebuilt, so
          scroll position and the selected document survive collapsing and full screen.
        */}
        <div className="board">
        {!manifest || categories.length === 0 ? (
          <div className="empty">
            <span className="empty__ic">
              <Icon name={configured === false ? 'settings' : 'doc'} size={46} />
            </span>
            <div className="empty__t">
              {configured === false ? t(lang, 'notConfigured') : t(lang, 'noContent')}
            </div>
            <div className="empty__s">{t(lang, 'noContentHint')}</div>
          </div>
        ) : (
          // Keying on category AND language remounts the scroller, so switching
          // either always starts the operator at the top of the list.
          <div className="scroll" key={`${current?.id}-${lang}`}>
            {current && (
              <div className="cat-hd">
                <span className="cat-hd__ic" style={{ background: current.colour }}>
                  <Icon name={current.icon} size={30} />
                </span>
                <div>
                  <div className="cat-hd__t">{catName(current, lang)}</div>
                  <div className="cat-hd__s">
                    {currentDocs.length} {plural(lang, currentDocs.length)}
                    {cycling && settings.cycleEnabled && categories.length > 1
                      ? ` · ${t(lang, 'tapToPause')}`
                      : ''}
                  </div>
                </div>
              </div>
            )}

            {currentDocs.length === 0 ? (
              <div className="empty" style={{ height: 'auto', paddingTop: 60 }}>
                <span className="empty__ic"><Icon name="doc" size={44} /></span>
                <div className="empty__t">{t(lang, 'emptyCategory')}</div>
              </div>
            ) : (
              <div className="grid">
                {currentDocs.map((d) => (
                  <DocCard
                    key={d.id}
                    doc={d}
                    lang={lang}
                    category={current}
                    cached={cachedIds.has(d.versionId)}
                    compact={splitOpen}
                    selected={splitOpen && openDoc?.id === d.id}
                    onOpen={(doc) => { setOpenDoc(doc); noteActivity(); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </div>

        {/*
          Wide layout: the document lives here, beside the list, and takes every pixel the
          list does not. Full screen is handled inside the viewer by a class that lifts it to
          a fixed overlay, which behaves far more predictably in a WebView than the
          Fullscreen API does.
        */}
        {splitOpen && (
          <section className="split__pane">
            <Suspense fallback={<div className="vw__loading">{t(lang, 'loading')}</div>}>
            <PdfViewer
              doc={openDoc}
              lang={lang}
              variant="pane"
              fullscreen={fullscreen}
              onToggleFullscreen={() => { setFullscreen((f) => !f); noteActivity(); }}
              listHidden={listHidden}
              onToggleList={() => { setListHidden((h) => !h); noteActivity(); }}
              onClose={() => { setOpenDoc(null); noteActivity(); }}
              onActivity={noteActivity}
            />
            </Suspense>
          </section>
        )}
      </main>

      {searching && manifest && (
        <SearchOverlay
          docs={manifest.documents}
          categories={manifest.categories}
          lang={lang}
          cachedIds={cachedIds}
          onOpen={(d) => { setOpenDoc(d); setSearching(false); }}
          onClose={() => { setSearching(false); noteActivity(); }}
          onActivity={noteActivity}
        />
      )}

      {/*
        Narrow layout: the document covers the screen, because a split on a phone would leave
        both halves too small to use. Full screen still applies — it drops the toolbars.
      */}
      {openDoc && !split && (
        <Suspense fallback={<div className="vw vw--overlay"><div className="vw__loading">{t(lang, 'loading')}</div></div>}>
        <PdfViewer
          doc={openDoc}
          lang={lang}
          variant="overlay"
          fullscreen={fullscreen}
          onToggleFullscreen={() => { setFullscreen((f) => !f); noteActivity(); }}
          onClose={() => { setOpenDoc(null); noteActivity(); }}
          onActivity={noteActivity}
        />
        </Suspense>
      )}

      {pinOpen && (
        <PinPad
          lang={lang}
          onOk={() => { setPinOpen(false); setScreen('service'); }}
          onCancel={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
