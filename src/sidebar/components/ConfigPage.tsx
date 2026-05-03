import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Link as LinkIcon,
  Upload,
} from 'lucide-react';
import { IconButton } from './IconButton';
import { LangBadge } from './LangBadge';
import { t, type Lang } from '../i18n';
import { bg, clog } from '../lib/messages';

interface ConfigDraft {
  url: string;
  token: string;
  name: string;
}

async function loadDraft(): Promise<ConfigDraft> {
  const d = (await chrome.storage.local.get([
    'gatewayUrlDraft',
    'gatewayTokenDraft',
    'browserNameDraft',
    'gatewayUrl',
    'gatewayToken',
    'browserName',
  ])) as Record<string, string | undefined>;
  return {
    url: d.gatewayUrlDraft || d.gatewayUrl || '',
    token: d.gatewayTokenDraft || d.gatewayToken || '',
    name: d.browserNameDraft || d.browserName || '',
  };
}

function saveDraftDebounced(draft: ConfigDraft): void {
  const w = window as unknown as { __cfgDraftTimer__?: number };
  if (w.__cfgDraftTimer__) clearTimeout(w.__cfgDraftTimer__);
  w.__cfgDraftTimer__ = window.setTimeout(() => {
    chrome.storage.local
      .set({
        gatewayUrlDraft: draft.url.trim(),
        gatewayTokenDraft: draft.token.trim(),
        browserNameDraft: draft.name.trim(),
      })
      .catch(() => {});
  }, 600) as unknown as number;
}

export function ConfigPage({
  lang,
  onToggleLang,
  connecting,
  gaveUp,
  pairingPending,
  pairingDeviceId,
  onToast,
}: {
  lang: Lang;
  onToggleLang: () => void;
  connecting: boolean;
  gaveUp: boolean;
  pairingPending: boolean;
  pairingDeviceId: string | null;
  onToast: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState<ConfigDraft>({ url: '', token: '', name: '' });
  const [showToken, setShowToken] = useState(false);
  const [shake, setShake] = useState<'url' | 'token' | null>(null);
  const [copied, setCopied] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDraft().then(setDraft).catch(() => {});
  }, []);

  const onConnect = async () => {
    if (!draft.url.trim()) {
      setShake('url');
      setTimeout(() => setShake(null), 1500);
      return;
    }
    if (!draft.token.trim()) {
      setShake('token');
      setTimeout(() => setShake(null), 1500);
      return;
    }
    const name = draft.name.trim() || 'browser-' + Math.random().toString(36).slice(2, 6);
    await chrome.storage.local.set({
      gatewayUrl: draft.url.trim(),
      gatewayToken: draft.token.trim(),
      browserName: name,
      gatewayUrlDraft: draft.url.trim(),
      gatewayTokenDraft: draft.token.trim(),
      browserNameDraft: name,
    });
    try {
      await bg.connect(draft.url.trim(), draft.token.trim(), name);
    } catch (e) {
      clog('error', 'connect RPC failed', { error: (e as Error).message });
    }
  };

  const onExport = async () => {
    const d = (await chrome.storage.local.get([
      'gatewayUrl',
      'gatewayToken',
      'browserName',
    ])) as Record<string, string | undefined>;
    const json = JSON.stringify(
      {
        _clawtab: true,
        gatewayUrl: d.gatewayUrl || '',
        gatewayToken: d.gatewayToken || '',
        browserName: d.browserName || '',
      },
      null,
      2,
    );
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([json], { type: 'application/json' })),
      download: 'clawtab-config.json',
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const onImport = async (file: File) => {
    try {
      const cfg = JSON.parse(await file.text()) as {
        gatewayUrl?: string;
        gatewayToken?: string;
        browserName?: string;
      };
      if (!cfg.gatewayUrl) throw new Error('invalid');
      const next = {
        url: cfg.gatewayUrl || '',
        token: cfg.gatewayToken || '',
        name: cfg.browserName || '',
      };
      await chrome.storage.local.set({
        gatewayUrl: next.url,
        gatewayToken: next.token,
        browserName: next.name,
        gatewayUrlDraft: next.url,
        gatewayTokenDraft: next.token,
        browserNameDraft: next.name,
      });
      setDraft(next);
      try {
        await bg.disconnect();
      } catch {
        /* ignore */
      }
      onToast(t(lang, 'importSuccess'));
    } catch {
      onToast(t(lang, 'importError'), true);
    }
  };

  const update = (patch: Partial<ConfigDraft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      saveDraftDebounced(next);
      return next;
    });
  };

  // ── Pairing panel ──
  if (pairingPending) {
    return (
      <div className="flex h-full flex-col bg-slate-50">
        <header className="flex h-[44px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3">
          <h1 className="text-[14px] font-semibold text-slate-900">{t(lang, 'connectTitle')}</h1>
          <IconButton
            tooltip={t(lang, 'langSwitchTo')}
            variant="ghost"
            size="sm"
            onClick={onToggleLang}
          >
            <LangBadge currentLang={lang} />
          </IconButton>
        </header>
        <div className="flex flex-1 flex-col items-center px-4 py-6">
          <div className="flex w-full max-w-xs flex-col items-center rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-brand-soft text-brand">
              <LinkIcon size={20} />
            </div>
            <div className="mb-1 text-[14px] font-semibold text-slate-900">
              {t(lang, 'pairingTitle')}
            </div>
            <div className="mb-3 text-center text-[12px] text-slate-500">
              {t(lang, 'pairingDesc')}
            </div>
            <div className="mb-3 flex w-full items-center gap-2 rounded-lg bg-slate-100 px-3 py-2 font-mono text-[12px] text-slate-900">
              <span className="flex-1 truncate">
                {pairingDeviceId ? pairingDeviceId.slice(0, 24) + '…' : '—'}
              </span>
              <IconButton
                tooltip={t(lang, 'pairingCopy')}
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!pairingDeviceId) return;
                  await navigator.clipboard.writeText(
                    `openclaw devices approve ${pairingDeviceId}`,
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </IconButton>
            </div>
            <div className="mb-1 self-start text-[11px] font-medium text-slate-500">
              {t(lang, 'pairingOr')}
            </div>
            <div className="mb-4 w-full rounded-lg bg-slate-900 px-3 py-2 font-mono text-[11px] text-slate-100">
              {pairingDeviceId
                ? `openclaw devices approve ${pairingDeviceId.slice(0, 16)}`
                : 'openclaw devices approve'}
            </div>
            <button
              type="button"
              onClick={() => bg.disconnect().catch(() => {})}
              className="h-9 w-full rounded-lg border border-slate-200 bg-white text-[12px] font-medium text-slate-600 transition hover:bg-slate-50"
            >
              {t(lang, 'pairingCancel')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Config form ──
  return (
    <div className="flex h-full flex-col bg-slate-50">
      <header className="flex h-[44px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3">
        <h1 className="text-[14px] font-semibold text-slate-900">{t(lang, 'connectTitle')}</h1>
        <IconButton
          tooltip={t(lang, 'langSwitchTo')}
          variant="ghost"
          size="sm"
          onClick={onToggleLang}
        >
          <LangBadge currentLang={lang} />
        </IconButton>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {gaveUp ? (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {t(lang, 'connFailed')}
          </div>
        ) : null}

        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-slate-500">
            {t(lang, 'configTitle')}
          </h2>
          <div className="flex gap-1">
            <IconButton
              tooltip={t(lang, 'exportConfig')}
              variant="square"
              size="sm"
              onClick={onExport}
            >
              <Upload size={13} />
            </IconButton>
            <IconButton
              tooltip={t(lang, 'importConfig')}
              variant="square"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Download size={13} />
            </IconButton>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.clawtab"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) await onImport(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        <label className="mb-4 block">
          <span className="mb-1 block text-[11px] font-medium text-slate-600">
            {t(lang, 'gatewayUrl')}
          </span>
          <input
            type="url"
            value={draft.url}
            onChange={(e) => update({ url: e.target.value })}
            disabled={connecting}
            placeholder={t(lang, 'gatewayUrlPh')}
            autoComplete="off"
            spellCheck={false}
            className={`block h-9 w-full rounded-lg border px-3 text-[12px] text-slate-900 transition placeholder:text-slate-400 focus:border-brand-ring focus:outline-none focus:ring-2 focus:ring-brand-ring/30 disabled:bg-slate-100 ${shake === 'url' ? 'animate-pulse border-red-500' : 'border-slate-200 bg-white'}`}
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-[11px] font-medium text-slate-600">
            {t(lang, 'token')}
          </span>
          <div className="relative">
            <input
              type={showToken ? 'text' : 'password'}
              value={draft.token}
              onChange={(e) => update({ token: e.target.value })}
              disabled={connecting}
              placeholder={t(lang, 'tokenPh')}
              autoComplete="off"
              spellCheck={false}
              className={`block h-9 w-full rounded-lg border px-3 pr-9 text-[12px] text-slate-900 transition placeholder:text-slate-400 focus:border-brand-ring focus:outline-none focus:ring-2 focus:ring-brand-ring/30 disabled:bg-slate-100 ${shake === 'token' ? 'animate-pulse border-red-500' : 'border-slate-200 bg-white'}`}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowToken((v) => !v)}
              title={t(lang, 'toggleToken')}
              aria-label={t(lang, 'toggleToken')}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            >
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-[11px] font-medium text-slate-600">
            {t(lang, 'channelName')}
          </span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            disabled={connecting}
            maxLength={40}
            placeholder={t(lang, 'channelNamePh')}
            autoComplete="off"
            spellCheck={false}
            className="block h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-[12px] text-slate-900 transition placeholder:text-slate-400 focus:border-brand-ring focus:outline-none focus:ring-2 focus:ring-brand-ring/30 disabled:bg-slate-100"
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            {t(lang, 'channelNameHint')}
          </span>
        </label>

        <button
          type="button"
          onClick={onConnect}
          disabled={connecting}
          className="h-10 w-full rounded-lg bg-brand text-[13px] font-semibold text-white shadow-sm transition hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-70"
        >
          {connecting ? t(lang, 'connecting') : t(lang, 'connect')}
        </button>
      </div>
    </div>
  );
}
