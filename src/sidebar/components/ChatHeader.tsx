import { Download, Power, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from './IconButton';
import { LangBadge } from './LangBadge';
import { Tooltip } from './Tooltip';
import { t, type Lang } from '../i18n';
import { bg, clog } from '../lib/messages';
import type { DiagBundle } from '@/shared/types/state';

function formatDiag(bundle: DiagBundle): string {
  const date = new Date(bundle.generatedAt).toISOString();
  const lines: string[] = [];
  lines.push(`ClawTab Diagnostic Report`);
  lines.push(`Generated: ${date}`);
  lines.push(`Version: ${bundle.version}`);
  lines.push('');
  lines.push('=== State ===');
  lines.push(JSON.stringify(bundle.state, null, 2));
  lines.push('');
  lines.push('=== Config (redacted) ===');
  lines.push(JSON.stringify(bundle.config, null, 2));
  lines.push('');
  lines.push(`=== Logs (${bundle.logs.length}) ===`);
  for (const l of bundle.logs) {
    const tstamp = new Date(l.t).toISOString();
    const data = l.data ? ` | ${l.data}` : '';
    lines.push(`[${tstamp}] [${l.level}] [${l.src}] ${l.msg}${data}`);
  }
  lines.push('');
  lines.push(`=== Chat history (last ${bundle.chatHistory.length}) ===`);
  lines.push(JSON.stringify(bundle.chatHistory, null, 2));
  return lines.join('\n');
}

export function ChatHeader({
  lang,
  agent,
  agents,
  onSwitchAgent,
  connected,
  reconnecting,
  onToggleLang,
  onToast,
}: {
  lang: Lang;
  agent: string;
  agents: string[];
  onSwitchAgent: (a: string) => void;
  connected: boolean;
  reconnecting: boolean;
  onToggleLang: () => void;
  onToast: (text: string, error?: boolean) => void;
}) {
  const [exporting, setExporting] = useState(false);

  const statusText = connected
    ? t(lang, 'connected')
    : reconnecting
      ? t(lang, 'reconnecting')
      : t(lang, 'disconnected');

  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await bg.diagGet();
      if (!('ok' in res) || res.ok !== true) {
        onToast(t(lang, 'exportFailed'), true);
        return;
      }
      const text = formatDiag(res);
      const stamp = new Date(res.generatedAt)
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })),
        download: `clawtab-diag-${stamp}.txt`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {
      clog('error', 'export diag failed', { error: (e as Error).message });
      onToast(t(lang, 'exportFailed'), true);
    } finally {
      setExporting(false);
    }
  };

  const doClearLogs = async () => {
    if (!confirm(t(lang, 'clearLogsConfirm'))) return;
    try {
      await bg.logClear();
      onToast(t(lang, 'logsCleared'));
    } catch (e) {
      clog('error', 'clearLogs failed', { error: (e as Error).message });
    }
  };

  return (
    <header className="flex h-[44px] shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2">
      <Tooltip label="Agent">
        <select
          value={agent}
          onChange={(e) => onSwitchAgent(e.target.value)}
          className="h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 focus:border-brand-ring focus:outline-none"
        >
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Tooltip>
      <div className="flex flex-1 items-center gap-1.5">
        <span
          className={
            'inline-block h-2 w-2 rounded-full ' +
            (connected
              ? 'bg-green-500'
              : reconnecting
                ? 'bg-amber-500 animate-pulse'
                : 'bg-slate-300')
          }
        />
        <span className="text-[11.5px] text-slate-500">{statusText}</span>
      </div>
      <IconButton tooltip={t(lang, 'exportLogs')} variant="ghost" size="sm" onClick={doExport}>
        <Download size={14} />
      </IconButton>
      <IconButton tooltip={t(lang, 'clearLogs')} variant="ghost" size="sm" onClick={doClearLogs}>
        <Trash2 size={14} />
      </IconButton>
      <IconButton
        tooltip={t(lang, 'langSwitchTo')}
        variant="ghost"
        size="sm"
        onClick={onToggleLang}
      >
        <LangBadge currentLang={lang} />
      </IconButton>
      <IconButton
        tooltip={t(lang, 'disconnect')}
        variant="ghost"
        size="sm"
        onClick={() => bg.disconnect().catch(() => {})}
      >
        <Power size={14} />
      </IconButton>
    </header>
  );
}
