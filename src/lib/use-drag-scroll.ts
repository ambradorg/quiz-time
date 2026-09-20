"use client";

/**
 * Sideways drag-to-scroll for a pill row that is wider than the screen.
 *
 * Why this exists: the quiz mode switch has five labelled tabs, and they want
 * ~480px while a phone gives them ~360px. Shrinking the tabs only moved the
 * problem around — the last tab hung past the card edge and `body { overflow-x:
 * hidden }` sliced it off. So the row scrolls instead, and scrolling needs an
 * affordance on a desktop, where dragging a mouse across a scroll container
 * does nothing by itself.
 *
 * Touch is deliberately left alone: a touch-drag on an `overflow-x: auto`
 * element is already handled natively, with momentum and axis chaining (so a
 * vertical swipe still scrolls the page). Only mouse drags are emulated here.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

/** Travel before a press counts as a drag instead of a click, in px. */
const DRAG_SLOP = 5;
/** Layout maths is sub-pixel: 1px either side counts as "against the edge". */
const EDGE_EPSILON = 1;

export interface DragScrollRow {
  /** Callback ref for the scroll container: `ref={row.setRow}`. */
  setRow: (node: HTMLElement | null) => void;
  /** Does the row have anything to scroll at all? */
  scrollable: boolean;
  /** True when nothing is hidden to the left of the viewport. */
  atStart: boolean;
  /** True when nothing is hidden to the right of the viewport. */
  atEnd: boolean;
  /** A mouse drag is in progress — used for the grabbing cursor. */
  dragging: boolean;
  /** Spread these onto the scroll container. */
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
    onScroll: () => void;
  };
  /** Scroll by roughly a page (dir -1 = left, 1 = right). */
  nudge: (dir: -1 | 1) => void;
}

export interface DragScrollOptions {
  /**
   * Index of the child that should stay visible — the active tab, usually.
   * Whenever it changes (including on mount) that child is scrolled into view,
   * so a tab chosen from elsewhere in the UI can never end up selected while
   * sitting off-screen. Pass -1 for "nothing to reveal".
   */
  revealIndex?: number;
}

function prefersSmoothScrolling(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useDragScroll({ revealIndex = -1 }: DragScrollOptions = {}): DragScrollRow {
  const [scrollable, setScrollable] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  const [dragging, setDragging] = useState(false);

  /** The row mounts late (only once a mode exists), so it needs state, not just
   * a ref, for the size watcher below to ever see it. */
  const [node, setNode] = useState<HTMLElement | null>(null);
  const row = useRef<HTMLElement | null>(null);
  const setRow = useCallback((el: HTMLElement | null) => {
    row.current = el;
    setNode(el);
  }, []);

  /** The current mouse press, or null when the pointer isn't down. */
  const press = useRef<{ id: number; x: number; left: number; moved: boolean } | null>(null);
  /** Set when a drag ends, so the click it would otherwise fire is eaten. */
  const swallowClick = useRef(false);
  /** Scroll events fire faster than paint; measure once per frame. */
  const measuring = useRef(false);

  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setScrollable(max > EDGE_EPSILON);
    setAtStart(el.scrollLeft <= EDGE_EPSILON);
    setAtEnd(el.scrollLeft >= max - EDGE_EPSILON);
  }, []);

  const onScroll = useCallback(() => {
    if (measuring.current) return;
    measuring.current = true;
    requestAnimationFrame(() => {
      measuring.current = false;
      measure();
    });
  }, [measure]);

  // Re-measure when the row or any of its children change size: a font
  // finishing loading, a due badge appearing, or the phone flipping to
  // landscape all change how much of the row is off-screen.
  useEffect(() => {
    if (!node) return;
    if (typeof ResizeObserver === "undefined") {
      measure();
      return;
    }
    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    for (const child of Array.from(node.children)) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [node, measure]);

  // Put the requested child in view — on mount, and whenever it changes.
  useEffect(() => {
    const el = row.current;
    if (!el || revealIndex < 0) return;
    const child = el.children.item(revealIndex) as HTMLElement | null;
    if (!child) return;
    // Assigning scrollLeft rather than calling scrollIntoView keeps the page
    // from scrolling along with it — the row sits near the top of the screen,
    // where a vertical jump would be very visible.
    const gap = 4;
    const from = child.offsetLeft - gap;
    const to = child.offsetLeft + child.offsetWidth + gap;
    if (from < el.scrollLeft) {
      el.scrollLeft = Math.max(0, from);
    } else if (to > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.min(el.scrollWidth - el.clientWidth, to - el.clientWidth);
    }
    measure();
  }, [revealIndex, node, measure]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Touch and pen scroll natively; only a mouse needs the help. Left button only.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const el = row.current;
    if (!el) return;
    swallowClick.current = false;
    press.current = { id: event.pointerId, x: event.clientX, left: el.scrollLeft, moved: false };
  }, []);

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = press.current;
    const el = row.current;
    if (!current || !el || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x;
    if (!current.moved) {
      // Under the slop, this is still a tap on a tab.
      if (Math.abs(dx) < DRAG_SLOP) return;
      current.moved = true;
      setDragging(true);
      try {
        // Capture so the drag keeps tracking once the pointer leaves the row.
        el.setPointerCapture(event.pointerId);
      } catch {
        // Pointer already gone — the drag still works while it is over the row.
      }
    }
    el.scrollLeft = current.left - dx;
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const current = press.current;
    const el = row.current;
    if (!current || event.pointerId !== current.id) return;
    press.current = null;
    setDragging(false);
    if (el?.hasPointerCapture?.(event.pointerId)) {
      try {
        el.releasePointerCapture(event.pointerId);
      } catch {
        // Already released by the browser — nothing to undo.
      }
    }
    // A drag that ends over a tab must not switch mode on release.
    if (current.moved) swallowClick.current = true;
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const nudge = useCallback((dir: -1 | 1) => {
    const el = row.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.8, 120) * dir;
    el.scrollBy({ left: amount, behavior: prefersSmoothScrolling() ? "smooth" : "auto" });
  }, []);

  return {
    setRow,
    scrollable,
    atStart,
    atEnd,
    dragging,
    handlers: {
      onPointerDown: startDrag,
      onPointerMove: moveDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
      onScroll,
    },
    nudge,
  };
}
