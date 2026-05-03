import { MessageSquare } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '@/shared/types/protocol';
import { MessageBubble } from './MessageBubble';
import { t, type Lang } from '../i18n';

export function MessageList({
  lang,
  connected,
  agent,
  messages,
  waiting,
  chatError,
}: {
  lang: Lang;
  connected: boolean;
  agent: string;
  messages: ChatMessage[];
  waiting: boolean;
  chatError: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, waiting, chatError]);

  useEffect(() => {
    // Delegate link clicks: open in a new browser tab rather than try to
    // navigate the (tiny, sandboxed) sidepanel.
    const el = containerRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || !/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      chrome.tabs.create({ url: href, active: true }).catch(() => {
        window.open(href, '_blank', 'noopener,noreferrer');
      });
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, []);

  if (!connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-[12px] text-slate-400">
        <MessageSquare size={40} className="mb-2 opacity-60" />
        <div>{t(lang, 'emptyConnect')}</div>
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-[12px] text-slate-400">
        <MessageSquare size={40} className="mb-2 opacity-60" />
        <div
          dangerouslySetInnerHTML={{
            __html: t(lang, 'emptyChat').replace(
              '{agent}',
              `<strong class="text-slate-700">${agent}</strong>`,
            ),
          }}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full flex-col gap-2 overflow-y-auto px-3 py-3">
      {messages.map((m, i) => (
        <MessageBubble key={(m.id ?? 'idx-') + i} msg={m} />
      ))}
      {waiting ? (
        <div className="self-start rounded-full bg-slate-100 px-3 py-2">
          <span className="inline-flex gap-1">
            <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-slate-400 [animation-delay:-0.32s]" />
            <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-slate-400 [animation-delay:-0.16s]" />
            <span className="h-1.5 w-1.5 animate-thinking-dot rounded-full bg-slate-400" />
          </span>
        </div>
      ) : null}
      {chatError ? (
        <div className="self-center rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
          {chatError}
        </div>
      ) : null}
    </div>
  );
}
