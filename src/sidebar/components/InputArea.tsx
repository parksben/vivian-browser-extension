import { MousePointer2, MessageSquarePlus, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from './IconButton';
import { AttachmentChip } from './MessageBubble';
import { t, type Lang } from '../i18n';
import type { Attachment } from '../state/reducer';

export function InputArea({
  lang,
  wsConnected,
  reconnecting,
  waiting,
  sending,
  pickMode,
  attachments,
  onTogglePickMode,
  onClearContext,
  onSend,
  onRemoveAttachment,
}: {
  lang: Lang;
  wsConnected: boolean;
  reconnecting: boolean;
  waiting: boolean;
  sending: boolean;
  pickMode: boolean;
  attachments: Attachment[];
  onTogglePickMode: () => void;
  onClearContext: () => void;
  onSend: (text: string) => void;
  onRemoveAttachment: (index: number) => void;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [acOpen, setAcOpen] = useState(false);
  const [acActive, setAcActive] = useState(-1);
  const [acOptions, setAcOptions] = useState<string[]>([]);

  const disabled = !wsConnected || waiting;
  const sendDisabled = disabled || sending || !text.trim();

  const placeholder = reconnecting
    ? t(lang, 'placeholderReconnecting')
    : wsConnected
      ? t(lang, 'placeholderOn')
      : t(lang, 'placeholderOff');

  const updateAutocomplete = () => {
    const input = taRef.current;
    if (!input || attachments.length === 0) {
      setAcOpen(false);
      return;
    }
    const before = input.value.slice(0, input.selectionStart ?? 0);
    const m = before.match(/#([\w:]*)$/);
    if (!m) {
      setAcOpen(false);
      return;
    }
    const typed = m[1];
    const opts = attachments
      .map((a, i) => `#${i + 1}:${a.tag}`)
      .filter((label) => label.startsWith('#' + typed));
    if (opts.length === 0) {
      setAcOpen(false);
      return;
    }
    setAcOptions(opts);
    setAcActive(-1);
    setAcOpen(true);
  };

  const selectAutocomplete = (label: string) => {
    const input = taRef.current;
    if (!input) return;
    const before = input.value.slice(0, input.selectionStart ?? 0);
    const m = before.match(/#([\w:]*)$/);
    if (!m) return;
    const hashStart = (input.selectionStart ?? 0) - m[0].length;
    const after = input.value.slice(input.selectionStart ?? 0);
    const nv = input.value.slice(0, hashStart) + label + after;
    setText(nv);
    setAcOpen(false);
    requestAnimationFrame(() => {
      input.focus();
      const pos = hashStart + label.length;
      input.setSelectionRange(pos, pos);
    });
  };

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [text]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || sendDisabled) return;
    onSend(trimmed);
    setText('');
    setAcOpen(false);
  };

  return (
    <div className="relative border-t border-slate-200 bg-white">
      {acOpen ? (
        <div className="absolute bottom-full left-3 mb-1 max-h-40 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg">
          {acOptions.map((label, i) => (
            <div
              key={label}
              className={
                'cursor-pointer px-3 py-1.5 text-[12px] ' +
                (i === acActive ? 'bg-brand-soft text-brand' : 'hover:bg-slate-50')
              }
              onMouseDown={(e) => {
                e.preventDefault();
                selectAutocomplete(label);
              }}
            >
              {label}
            </div>
          ))}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 py-1">
          {attachments.map((a, i) => (
            <AttachmentChip
              key={i}
              attachment={a}
              index={i}
              interactive
              onDelete={() => onRemoveAttachment(i)}
            />
          ))}
        </div>
      ) : null}

      <div className={'flex items-end gap-1 px-2 py-2 ' + (disabled ? 'opacity-60' : '')}>
        <IconButton
          tooltip={t(lang, 'pickElement')}
          size="md"
          disabled={!wsConnected}
          active={pickMode}
          onClick={onTogglePickMode}
        >
          <MousePointer2 size={14} />
        </IconButton>
        <IconButton
          tooltip={t(lang, 'clearContext')}
          size="md"
          disabled={!wsConnected}
          onClick={onClearContext}
        >
          <MessageSquarePlus size={14} />
        </IconButton>
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            updateAutocomplete();
          }}
          onKeyDown={(e) => {
            if (acOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAcActive((i) => Math.min(i + 1, acOptions.length - 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAcActive((i) => Math.max(i - 1, 0));
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)) {
                const pick =
                  acActive >= 0 ? acOptions[acActive] : e.key === 'Tab' ? acOptions[0] : null;
                if (pick) {
                  e.preventDefault();
                  selectAutocomplete(pick);
                  return;
                }
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setAcOpen(false);
                return;
              }
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !waiting) {
              e.preventDefault();
              send();
            }
          }}
          onBlur={() => setTimeout(() => setAcOpen(false), 150)}
          className="min-h-[36px] flex-1 resize-none overflow-hidden rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:border-brand-ring focus:outline-none focus:ring-2 focus:ring-brand-ring/30 disabled:bg-slate-100"
        />
        <IconButton
          tooltip={t(lang, 'sendMessage')}
          size="md"
          disabled={sendDisabled}
          onClick={send}
          className="!bg-brand !text-white hover:!bg-brand-hover disabled:!bg-slate-200 disabled:!text-slate-400"
        >
          <Send size={15} />
        </IconButton>
      </div>
    </div>
  );
}
