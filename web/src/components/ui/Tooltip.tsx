"use client";

import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "@/lib/format";

/** `ink` = black box, white type (for the white workspace). `white` = white box, ink border (for the dark rail). */
export type TipTone = "ink" | "white";

interface Placement {
  top: number;
  left: number;
  side: "top" | "bottom";
}

/**
 * Square tooltip per DESIGN.md: 12/16 text, 4px/8px padding, 260px max, 2px radius, 1px hard
 * offset shadow instead of blur. Opens on hover and on keyboard focus anywhere inside the trigger,
 * sits above the trigger and flips below when there is no room. Rendered through a portal so a
 * clipped ancestor (`.segmented` has `overflow: hidden`) or the sticky rail cannot cut it off.
 * `open` forces it for screenshots and tests.
 */
export function Tooltip({
  content,
  children,
  tone = "ink",
  block,
  className,
  open: forced,
}: {
  content: ReactNode;
  children: ReactNode;
  tone?: TipTone;
  /** Wrapper becomes a flex block so a `w-full` control keeps its width. */
  block?: boolean;
  className?: string;
  open?: boolean;
}) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const shown = (forced ?? false) || hover || focus;
  const hasContent = content !== null && content !== undefined && content !== "";
  const visible = shown && hasContent;

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const t = tipRef.current?.getBoundingClientRect();
      if (!a || !t) return;
      const gap = 6;
      const pad = 8;
      const side: Placement["side"] = a.top - t.height - gap < pad ? "bottom" : "top";
      const top = side === "top" ? a.top - t.height - gap : a.bottom + gap;
      const centred = a.left + a.width / 2 - t.width / 2;
      const left = Math.max(pad, Math.min(centred, window.innerWidth - t.width - pad));
      setPos({ top, left, side });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, content]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHover(false);
        setFocus(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  const child =
    isValidElement(children) && visible
      ? cloneElement(children as ReactElement<{ "aria-describedby"?: string }>, { "aria-describedby": id })
      : children;

  return (
    <span
      ref={anchorRef}
      className={cx("tip-anchor", block && "tip-anchor-block", className)}
      onMouseEnter={() => {
        setPos(null);
        setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      onFocus={() => {
        setPos(null);
        setFocus(true);
      }}
      onBlur={() => setFocus(false)}
    >
      {child}
      {visible && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tipRef}
              id={id}
              role="tooltip"
              className={cx("tip", tone === "white" ? "tip-white" : "tip-ink")}
              data-side={pos?.side ?? "top"}
              style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

/**
 * 12px square "i" in ink-3 that darkens on hover; a real button so the keyboard reaches it.
 * With `tip` it carries its own tooltip, which is how it is used after every non-obvious label.
 */
export function InfoGlyph({ tip, tone, label = "Explain", className }: { tip?: ReactNode; tone?: TipTone; label?: string; className?: string }) {
  const glyph = (
    <button
      type="button"
      className={cx("ig", className)}
      aria-label={label}
      onClick={(e) => {
        // Never toggle a surrounding <summary> or submit a surrounding form.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      i
    </button>
  );
  return tip ? (
    <Tooltip content={tip} tone={tone}>
      {glyph}
    </Tooltip>
  ) : (
    glyph
  );
}

/**
 * A disabled `<button>` emits no mouse events, so the reason lives on a span that owns hover and
 * focus; the control inside keeps `disabled` (the wrapper adds `aria-disabled` for good measure).
 * Renders the child untouched when there is no reason.
 */
export function Disabled({
  reason,
  children,
  tone,
  block,
  className,
}: {
  reason?: ReactNode;
  children: ReactNode;
  tone?: TipTone;
  block?: boolean;
  className?: string;
}) {
  if (!reason) return <>{children}</>;
  const child = isValidElement(children)
    ? cloneElement(children as ReactElement<{ "aria-disabled"?: boolean }>, { "aria-disabled": true })
    : children;
  return (
    <Tooltip content={reason} tone={tone} block={block}>
      <span className={cx("dis", block && "dis-block", className)} tabIndex={0}>
        {child}
      </span>
    </Tooltip>
  );
}
