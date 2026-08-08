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
import { HomeScreen } from './components/HomeScreen';
import { t, plural, formatDate } from './lib/i18n';
import { catName, matchesLang, DEFAULT_SETTINGS } from './lib/types';
import type { Doc, Lang, Manifest, SyncState } from './lib/types';
import { emptyState, getConnection, getLastSync, sync as runSync } from './lib/sync';
import { listFileIds, loadManifest, metaGet, metaSet, requestPersistence } from './lib/store';
import { importSeed } from './lib/seed';
import { useHoldGesture } from './lib/useHoldGesture';

type Screen = 'boot' | 'browse' | 'service';

/**
 * How long the panel waits before putting itself back on the home screen.
 *
 * A wall panel is left mid-document constantly — somebody reads two pages, walks off, and the
 * next person finds page 3 of a fire plan with no idea how they got there. Returning to the
 * home screen means every person who walks up finds the panel in the same state.
 *
 * Set per installation from Настройки in the management platform; the floor keeps a typo of
 * 0 from sending the panel home while somebody is still reading.
 */
const IDLE_HOME_MS_MIN = 15_000;
/** The idle check does not need to be precise, and a one-second timer on a wall panel is
 *  pointless work forever. */
const IDLE_TICK_MS = 5_000;

export default function App() {
  const [screen, setScreen] = useState<Screen>('boot');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [lang, setLang] = useState<Lang>('bg');
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [openDoc, setOpenDoc] = useState<Doc | null>(null);
  /*
    The document read most recently, kept after the viewer closes.

    A category holds twenty-odd rows that all begin with the same word. Someone working
    through them backs out of one and has to find where they were: without a mark the list
    looks identical to how it looked before they read anything.
  */
  const [lastReadId, setLastReadId] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Non-null while the bundled document set is being imported on first launch.
  const [seeding, setSeeding] = useState<{ done: number; total: number } | null>(null);
  const [cachedIds, setCachedIds] = useState<Set<string>>(new Set());
  const [syncState, setSyncState] = useState<SyncState>(emptyState());
  const [clock, setClock] = useState(new Date());

  /*
    A document takes the whole panel. It used to open in a pane beside the list on a wide
    screen, which is right for a desk but wrong here: this panel is read standing up from a
    metre away, and half of a 24" portrait screen is not enough for an A4 page at a legible
    size. One thing at a time, filling the screen.
  */
  const [fullscreen, setFullscreen] = useState(false);

  /** When the panel was last touched, for the return to the home screen. */
  const lastTouch = useRef<number>(Date.now());

  const settings = manifest?.settings ?? DEFAULT_SETTINGS;
  const idleHomeMs = Math.max(
    IDLE_HOME_MS_MIN,
    (settings.homeAfterIdleSeconds || DEFAULT_SETTINGS.homeAfterIdleSeconds) * 1000,
  );

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
      // Back from the document list is the home screen, which is what the reader sees as
      // the top of the app. Below that, back does nothing rather than leaving the kiosk.
      else if (activeCat) setActiveCat(null);
      noteActivity();
    };
    window.addEventListener('kioskBack', onBack);
    return () => window.removeEventListener('kioskBack', onBack);
  }, [pinOpen, openDoc, searching, screen, activeCat, noteActivity]);

  // -------------------------------------------------------------------- clock
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // ---------------------------------------------------- derived content model
  const categories = useMemo(() => {
    if (!manifest) return [];
    // Only categories that actually have something to show in the active language: a
    // category button that opens an empty list is worse than no button.
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

  /*
    Nothing is selected until somebody selects it.

    The panel used to open on the first category and then cycle through the rest on a timer.
    That was replaced on the COO's reading of it, and he was right: a list that changes on
    its own is unusable, because the thing you were about to touch moves. The panel now shows
    the home screen until a category is touched, and then stays on it.

    The only automatic change left is the return to the home screen after a minute of nobody
    touching anything, which puts the panel back where the next person expects to find it.
  */
  useEffect(() => {
    if (activeCat && !categories.some((c) => c.id === activeCat)) setActiveCat(null);
  }, [categories, activeCat]);

  const current = categories.find((c) => c.id === activeCat) || null;
  const currentDocs = current ? docsByCat.get(current.id) || [] : [];
  /** Home is simply nothing being selected. */
  const atHome = !current;

  // ------------------------------------------------------------- idle return
  // Any touch anywhere counts, including inside the document viewer, which sends its own
  // activity through `onActivity` as well as through this listener.
  useEffect(() => {
    const handler = () => noteActivity();
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, [noteActivity]);

  const goHome = useCallback(() => {
    setOpenDoc(null);
    // Going home ends the visit, so the next person does not arrive at a list with somebody
    // else's place marked in it.
    setLastReadId(null);
    setActiveCat(null);
    setSearching(false);
    setFullscreen(false);
    noteActivity();
  }, [noteActivity]);

  useEffect(() => {
    // The service screen and the PIN pad are somebody standing at the panel doing work, and
    // resetting under them would be actively harmful.
    if (screen !== 'browse' || pinOpen) return;
    const timer = setInterval(() => {
      if (Date.now() - lastTouch.current < idleHomeMs) return;
      // Already home and untouched: nothing to do, and resetting state every five seconds
      // forever would restart the home screen's animations.
      if (atHome && !openDoc && !searching) return;
      goHome();
    }, IDLE_TICK_MS);
    return () => clearInterval(timer);
  }, [screen, pinOpen, atHome, openDoc, searching, goHome, idleHomeMs]);

  const pickCategory = (catId: string) => {
    // Touching the category that is already open closes it and goes back to the home
    // screen, so the mark on the wall is never more than one touch away.
    setActiveCat((c) => (c === catId ? null : catId));
    setOpenDoc(null);
    setLastReadId(null);
    noteActivity();
  };

  // -------------------------------------------------- hidden service gesture
  // The timing, the touch handling and the tap fallback live in the hook; see the notes
  // there for why plain pointer events on the logo image never worked on the device.
  const openService = useCallback(() => setPinOpen(true), []);
  const hold = useHoldGesture(openService, 3000);

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

  return (
    // The home screen is the panel's resting state, and the header sheds some of its weight
    // for it: see `.app--home` in app.css.
    <div className={`app ${atHome ? 'app--home' : ''}`}>
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
              </button>
            );
          })}

          <span className="rail__spacer" />

          {/* Only offered once there is something to come back from, so the resting panel
              has no controls on it at all. */}
          {!atHome && (
            <button className="cyc" onClick={goHome}>
              <Icon name="arrowLeft" size={20} />
              <span>{t(lang, 'home')}</span>
            </button>
          )}
        </nav>
      )}

      <main className="main">
        <div className="board">
        {/*
          The home screen lives in the same pane the list uses, rather than covering the
          whole panel. Keeping the header and the category buttons in place means touching a
          category swaps the pane underneath them instead of replacing the screen, which is
          both faster to read and far less startling on a wall.
        */}
        {atHome && manifest && categories.length > 0 ? (
          <HomeScreen lang={lang} />
        ) : !manifest || categories.length === 0 ? (
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
              /* One document per row, full width. A grid of tiles fitted more titles on
                 screen but truncated most of them, and a policy document is identified by
                 its title and nothing else — the whole title has to be readable. */
              <div className="grid grid--rows">
                {currentDocs.map((d) => (
                  <DocCard
                    key={d.id}
                    doc={d}
                    lang={lang}
                    category={current ?? undefined}
                    cached={cachedIds.has(d.versionId)}
                    row
                    selected={d.id === lastReadId}
                    onOpen={(doc) => { setOpenDoc(doc); setLastReadId(doc.id); noteActivity(); }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        </div>

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
        A document covers the panel completely. Closing it goes back to the home screen
        rather than to the list: the reader has finished, and the next person should find the
        panel at rest. The list is still one touch away on the category that is still lit.
      */}
      {openDoc && (
        <Suspense fallback={<div className="vw vw--overlay"><div className="vw__loading">{t(lang, 'loading')}</div></div>}>
        <PdfViewer
          doc={openDoc}
          lang={lang}
          variant="overlay"
          fullscreen={fullscreen}
          onToggleFullscreen={() => { setFullscreen((f) => !f); noteActivity(); }}
          onBack={() => { setOpenDoc(null); noteActivity(); }}
          onClose={goHome}
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
