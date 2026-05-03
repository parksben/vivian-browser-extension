import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// Custom tooltip — replaces the native `title=` attribute.
//
// Why custom: native browser tooltips fire after ~1500ms with no styling
// hooks. That made every icon-only button feel slow ("did the click
// register?"). This component opens after `delayMs` (default 250ms),
// renders into document.body via a portal so the chat overflow / sidepanel
// iframe edges don't clip it, and auto-flips to the opposite side if the
// chosen edge would push the bubble off-screen.
//
// Accessibility:
//  - The trigger keeps any `aria-label` the caller already passed.
//  - We also set role="tooltip" on the bubble. Most icon buttons in this
//    codebase still receive aria-label via IconButton, so screen readers
//    don't depend on the visual tooltip.

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TooltipProps {
  label: ReactNode;
  children: ReactElement<{
    onMouseEnter?: (e: unknown) => void;
    onMouseLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  }>;
  side?: Side;
  delayMs?: number;
  disabled?: boolean;
}

interface Coords {
  x: number;
  y: number;
  transform: string;
  side: Side;
}

const TOOLTIP_MARGIN = 6;

function computePosition(rect: DOMRect, preferred: Side): Coords {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // Conservative bubble size guesses for flip detection — actual bubble
  // resizes to its content but flips will only fire when really needed.
  const bubbleH = 32;
  const bubbleW = 120;

  let side: Side = preferred;
  if (side === 'bottom' && rect.bottom + TOOLTIP_MARGIN + bubbleH > vh) side = 'top';
  else if (side === 'top' && rect.top - TOOLTIP_MARGIN - bubbleH < 0) side = 'bottom';
  else if (side === 'right' && rect.right + TOOLTIP_MARGIN + bubbleW > vw) side = 'left';
  else if (side === 'left' && rect.left - TOOLTIP_MARGIN - bubbleW < 0) side = 'right';

  switch (side) {
    case 'bottom':
      return {
        x: rect.left + rect.width / 2,
        y: rect.bottom + TOOLTIP_MARGIN,
        transform: 'translateX(-50%)',
        side,
      };
    case 'top':
      return {
        x: rect.left + rect.width / 2,
        y: rect.top - TOOLTIP_MARGIN,
        transform: 'translate(-50%, -100%)',
        side,
      };
    case 'right':
      return {
        x: rect.right + TOOLTIP_MARGIN,
        y: rect.top + rect.height / 2,
        transform: 'translateY(-50%)',
        side,
      };
    case 'left':
      return {
        x: rect.left - TOOLTIP_MARGIN,
        y: rect.top + rect.height / 2,
        transform: 'translate(-100%, -50%)',
        side,
      };
  }
}

export function Tooltip({
  label,
  children,
  side = 'bottom',
  delayMs = 250,
  disabled,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  const id = useId();

  // Clear the show timer if the component unmounts mid-delay.
  useEffect(
    () => () => {
      if (showTimer.current) clearTimeout(showTimer.current);
    },
    [],
  );

  if (disabled || !label || !isValidElement(children)) return children;

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    setCoords(computePosition(el.getBoundingClientRect(), side));
  };

  const show = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      place();
      setOpen(true);
    }, delayMs);
  };

  const hide = () => {
    if (showTimer.current) {
      clearTimeout(showTimer.current);
      showTimer.current = null;
    }
    setOpen(false);
  };

  // Forward listeners to the trigger so callers can still attach their own
  // mouse/focus handlers — we wrap, we don't replace.
  const childProps = children.props;
  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : undefined,
  } as Record<string, unknown>);

  const bubbleStyle: CSSProperties = coords
    ? {
        left: coords.x,
        top: coords.y,
        transform: coords.transform,
      }
    : {};

  return (
    <>
      <span
        ref={triggerRef}
        // `inline-flex` keeps the trigger box hugging the child (button),
        // doesn't add layout space.
        className="inline-flex"
        onMouseEnter={(e) => {
          show();
          childProps.onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          hide();
          childProps.onMouseLeave?.(e);
        }}
        onFocus={(e) => {
          show();
          childProps.onFocus?.(e);
        }}
        onBlur={(e) => {
          hide();
          childProps.onBlur?.(e);
        }}
      >
        {trigger}
      </span>
      {open && coords
        ? createPortal(
            <div
              role="tooltip"
              id={id}
              className="pointer-events-none fixed z-[9999] max-w-[240px] select-none rounded-md bg-slate-900 px-2 py-1 text-[11px] font-medium text-white shadow-lg shadow-black/15 ct-tooltip-bubble"
              style={bubbleStyle}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
