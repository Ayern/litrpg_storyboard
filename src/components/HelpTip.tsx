import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The width a bubble asks for before it is measured; a first render has no
// layout yet, so the clamp needs a size to work with.
export const HELP_BUBBLE_WIDTH = 280;

// Where a help bubble sits: under its button when there is room, above it when
// there is not, and never past the edge of the window. Kept apart from the
// component so the clamping can be checked without a browser laying anything
// out.
export function placeTooltip(
  trigger: { top: number; bottom: number; left: number; width: number },
  bubble: { width: number; height: number },
  viewport: { width: number; height: number }
): { top: number; left: number; placement: 'top' | 'bottom' } {
  const margin = 8;
  const gap = 6;

  const width = Math.min(bubble.width, Math.max(viewport.width - margin * 2, 0));
  const left = Math.round(
    Math.min(
      Math.max(trigger.left + trigger.width / 2 - width / 2, margin),
      Math.max(viewport.width - width - margin, margin)
    )
  );

  const fitsBelow = trigger.bottom + gap + bubble.height <= viewport.height - margin;
  const fitsAbove = trigger.top - gap - bubble.height >= margin;
  const placement: 'top' | 'bottom' = fitsBelow || !fitsAbove ? 'bottom' : 'top';
  const wanted = placement === 'bottom' ? trigger.bottom + gap : trigger.top - gap - bubble.height;
  const top = Math.round(
    Math.min(
      Math.max(wanted, margin),
      Math.max(viewport.height - bubble.height - margin, margin)
    )
  );

  return { top, left, placement };
}

// The small "?" that explains a dense control. The bubble opens on hover, on
// keyboard focus and on click, is announced through aria-describedby, and closes
// on Escape without moving focus. Its own position is fixed and clamped to the
// window, so it cannot be cut off by the panel it belongs to.
//
// The bubble is rendered into `document.body` rather than beside its button: a
// fixed element inside a scaled ancestor is positioned inside that transform, so
// on the zoomed canvas the same tooltip would land somewhere else at every zoom
// level. A portal puts it outside the board's transform and the coordinates stay
// viewport coordinates.
export function HelpTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{
    top: number;
    left: number;
    side: 'top' | 'bottom';
  } | null>(null);
  const bubbleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }

    const measure = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (!trigger) return;

      const bubble = bubbleRef.current?.getBoundingClientRect();
      const placed = placeTooltip(
        { top: trigger.top, bottom: trigger.bottom, left: trigger.left, width: trigger.width },
        { width: bubble?.width || HELP_BUBBLE_WIDTH, height: bubble?.height || 0 },
        { width: window.innerWidth, height: window.innerHeight }
      );

      setPlacement({ top: placed.top, left: placed.left, side: placed.placement });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

  return (
    <span
      className="help-tip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={triggerRef}
        type="button"
        className="help-tip-trigger"
        aria-label={`About ${label}`}
        aria-describedby={open ? bubbleId : undefined}
        // A click opens it too, which is what a touch screen taps; leaving the
        // button, blurring it or pressing Escape puts it away.
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !open) return;
          // Escape belongs to the bubble, not to the panel behind it.
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <span
            ref={bubbleRef}
            id={bubbleId}
            role="tooltip"
            className="help-tip-bubble"
            data-side={placement?.side ?? 'bottom'}
            style={
              placement
                ? { top: placement.top, left: placement.left }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
          >
            {children}
          </span>,
          document.body
        )}
    </span>
  );
}
