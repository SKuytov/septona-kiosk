/**
 * Hidden maintenance screen. Reached by holding the logo for 3 seconds and entering
 * the service PIN — so a passer-by cannot reconfigure the display, but an engineer
 * needs no keyboard shortcuts or adb.
 */
import { useEffect, useState, lazy, Suspense } from 'react';
import { Icon } from './Icon';
/*
  Loaded on demand. Diagnostics reports the PDF engine's build, which means it references the
  engine — and because this module also exports the PIN pad shown on the browse screen, that
  reference alone kept the whole engine in the initial bundle and delayed every start.
*/
const Diagnostics = lazy(() => import('./Diagnostics').then((m) => ({ default: m.Diagnostics })));
import { t, formatBytes, formatDate } from '../lib/i18n';
import { APP_VERSION, getConnection, setConnection, testConnection } from '../lib/sync';
import { cacheStats, clearFiles, requestPersistence } from '../lib/store';
import type { Lang, SyncState } from '../lib/types';

export const SERVICE_PIN = '2470';

interface PinPadProps {
  lang: Lang;
  onOk: () => void;
  onCancel: () => void;
}

export function PinPad({ lang, onOk, onCancel }: PinPadProps) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState('');

  const press = (d: string) => {
    setError('');
    const next = (digits + d).slice(0, 4);
    setDigits(next);
    if (next.length === 4) {
      if (next === SERVICE_PIN) onOk();
      else {
        setError(t(lang, 'wrongPin'));
        setTimeout(() => setDigits(''), 420);
      }
    }
  };

  return (
    <div className="pin" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="pin__box">
        <div className="pin__t">{t(lang, 'enterPin')}</div>
        <div className="pin__dots">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`pin__dot ${i < digits.length ? 'pin__dot--on' : ''}`} />
          ))}
        </div>
        <div className="pin__grid">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} className="pin__k" onClick={() => press(d)}>{d}</button>
          ))}
          <button className="pin__k" onClick={onCancel} aria-label={t(lang, 'close')}>
            <Icon name="x" size={22} />
          </button>
          <button className="pin__k" onClick={() => press('0')}>0</button>
          <button className="pin__k" onClick={() => setDigits((v) => v.slice(0, -1))} aria-label="⌫">
            <Icon name="chevronLeft" size={22} />
          </button>
        </div>
        <div className="pin__err">{error}</div>
      </div>
    </div>
  );
}

interface Props {
  lang: Lang;
  sync: SyncState;
  onSyncNow: () => void;
  onClose: () => void;
}

export function ServiceScreen({ lang, sync, onSyncNow, onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [deviceKey, setDeviceKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [stats, setStats] = useState({ count: 0, bytes: 0 });
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    void (async () => {
      const conn = await getConnection();
      if (conn) {
        setBaseUrl(conn.baseUrl);
        setDeviceKey(conn.deviceKey);
      } else if (/^https?:$/.test(window.location.protocol) && window.location.hostname !== 'localhost') {
        // Browser build: it is served by the same host as the API, so the address is
        // already known and only the device key needs entering.
        setBaseUrl(window.location.origin.replace(/\/+$/, ''));
      }
      setStats(await cacheStats());
      if (navigator.storage?.persisted) {
        try { setPersisted(await navigator.storage.persisted()); } catch { setPersisted(null); }
      }
    })();
  }, [sync.lastSyncAt, sync.cachedCount]);

  const normalisedUrl = baseUrl.trim().replace(/\/+$/, '');
  const valid = /^https?:\/\/.+/i.test(normalisedUrl) && deviceKey.trim().length > 10;

  const doTest = async () => {
    setBusy(true);
    setNote(null);
    const res = await testConnection({ baseUrl: normalisedUrl, deviceKey });
    setNote({ kind: res.ok ? 'ok' : 'err', text: res.message });
    setBusy(false);
  };

  const doSave = async () => {
    setBusy(true);
    setNote(null);
    await setConnection({ baseUrl: normalisedUrl, deviceKey });
    await requestPersistence();
    setNote({ kind: 'ok', text: 'Настройките са запазени. Стартира синхронизация…' });
    setBusy(false);
    onSyncNow();
  };

  const doClear = async () => {
    if (!window.confirm(t(lang, 'clearCacheConfirm'))) return;
    setBusy(true);
    await clearFiles();
    setStats(await cacheStats());
    setNote({ kind: 'info', text: 'Локалната памет е изчистена.' });
    setBusy(false);
  };

  return (
    <div className="setup">
      <div className="hdr">
        <span className="hdr__titles">
          <span className="hdr__title">{t(lang, 'setup')}</span>
          <span className="hdr__sub">Септона · сервизен режим</span>
        </span>
        <button className="hbtn" onClick={onClose}>
          <Icon name="x" size={22} />
          <span>{t(lang, 'exit')}</span>
        </button>
      </div>

      <div className="setup__body">
        <div className="setup__inner">
          <div className="panel">
            <h2 className="panel__t">Връзка със сървъра</h2>
            <div className="field">
              <label className="field__l" htmlFor="srv">{t(lang, 'serverUrl')}</label>
              <input
                id="srv"
                className="field__i"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://192.168.1.50:8080"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
              <span className="field__h">
                Адресът на управляващия сървър в локалната мрежа. Без наклонена черта в края.
              </span>
            </div>
            <div className="field">
              <label className="field__l" htmlFor="key">{t(lang, 'deviceKey')}</label>
              <input
                id="key"
                className="field__i"
                value={deviceKey}
                onChange={(e) => setDeviceKey(e.target.value)}
                placeholder="sk_…"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="field__h">
                Генерира се в административния панел → Устройства. Показва се само веднъж.
              </span>
            </div>
            <div className="btn-row">
              <button className="btn btn--sec" onClick={doTest} disabled={!valid || busy}>
                <Icon name="cloud" size={20} />
                <span>{t(lang, 'testConnection')}</span>
              </button>
              <button className="btn btn--pri" onClick={doSave} disabled={!valid || busy}>
                <Icon name="check" size={20} />
                <span>{t(lang, 'save')}</span>
              </button>
            </div>
            {note && (
              <div className={`note note--${note.kind}`} style={{ marginTop: 16 }}>
                {note.text}
              </div>
            )}
          </div>

          <div className="panel">
            <h2 className="panel__t">{t(lang, 'storage')}</h2>
            <div className="kv">
              <span className="kv__k">{t(lang, 'cached')}</span>
              <span className="kv__v">{stats.count}</span>
            </div>
            <div className="kv">
              <span className="kv__k">{t(lang, 'storage')}</span>
              <span className="kv__v">{formatBytes(stats.bytes)}</span>
            </div>
            <div className="kv">
              <span className="kv__k">{t(lang, 'lastSync')}</span>
              <span className="kv__v">{formatDate(sync.lastSyncAt, lang)}</span>
            </div>
            <div className="kv">
              <span className="kv__k">{t(lang, 'manifestVersion')}</span>
              <span className="kv__v">{sync.manifestVersion ?? '—'}</span>
            </div>
            <div className="kv">
              <span className="kv__k">{t(lang, 'appVersion')}</span>
              <span className="kv__v">{APP_VERSION}</span>
            </div>
            <div className="kv">
              <span className="kv__k">Защитена памет</span>
              <span className="kv__v">{persisted === null ? '—' : persisted ? 'да' : 'не'}</span>
            </div>

            {sync.progressTotal > 0 && sync.status === 'downloading' && (
              <div className="pbar">
                <i style={{ width: `${(sync.progressDone / sync.progressTotal) * 100}%` }} />
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 18 }}>
              <button className="btn btn--pri" onClick={onSyncNow} disabled={busy || sync.status === 'downloading'}>
                <Icon name="refresh" size={20} />
                <span>{t(lang, 'syncNow')}</span>
              </button>
              <button className="btn btn--dng" onClick={doClear} disabled={busy}>
                <Icon name="x" size={20} />
                <span>{t(lang, 'clearCache')}</span>
              </button>
            </div>
            {sync.message && (
              <div className="note note--info" style={{ marginTop: 16 }}>{sync.message}</div>
            )}
          </div>

          <Suspense fallback={<p className="svc__hint">{t(lang, 'loading')}</p>}>
            <Diagnostics />
          </Suspense>

          <div className="panel">
            <h2 className="panel__t">Указания за монтаж</h2>
            <div className="field__h" style={{ fontSize: '0.9rem', lineHeight: 1.6 }}>
              1. Свържете дисплея към мрежата и въведете адреса и ключа по-горе.<br />
              2. Натиснете «{t(lang, 'testConnection')}», след това «{t(lang, 'save')}».<br />
              3. Изчакайте първоначалното изтегляне да завърши — след това приложението
              работи напълно офлайн.<br />
              4. За връщане в този екран задръжте логото 3 секунди и въведете сервизния код.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
