"use client";

import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** k is screen pixels per diagram unit; (cx, cy) is the diagram point at the middle of the box. */
interface View { k: number; cx: number; cy: number }
interface Box { w: number; h: number }
export interface Point { x: number; y: number }

/** The opening zoom: names draw at about 10px (13px × 0.75), or larger when the whole tree fits. */
const OPEN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
/** One press of + or −. */
export const ZOOM_STEP = 1.25;
/** A press that moves further than this, in pixels, pans instead of clicking. */
const DRAG_PX = 4;
/** How far inside the edge, in diagram units, a focus point must sit to count as in view. */
const REVEAL_X = 200;
const REVEAL_Y = 40;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Keep a view on the diagram: never smaller than the whole tree (or than full size, for a
 * tree that fits larger), never past MAX_ZOOM, and never panned off the diagram's edges.
 */
function settle(v: View, box: Box, width: number, height: number): View {
  const k = clamp(v.k, Math.min(box.w / width, box.h / height, 1), MAX_ZOOM);
  const hw = box.w / k / 2;
  const hh = box.h / k / 2;
  return {
    k,
    cx: 2 * hw >= width ? width / 2 : clamp(v.cx, hw, width - hw),
    cy: 2 * hh >= height ? height / 2 : clamp(v.cy, hh, height - hh),
  };
}

const inView = (v: View, box: Box, p: Point) =>
  Math.abs(p.x - v.cx) <= box.w / v.k / 2 - REVEAL_X && Math.abs(p.y - v.cy) <= box.h / v.k / 2 - REVEAL_Y;

/**
 * Zoom and pan for a diagram drawn in a box of fixed size. Only the viewBox changes, so
 * the page around the box keeps its layout, and a pinch over the box never zooms the page.
 *
 * - Pinch, or Ctrl/⌘ + wheel: zoom at the pointer. The buttons and + − 0 zoom at the middle.
 * - Drag, or the wheel once zoomed in: pan. With the whole tree in view the wheel scrolls the page.
 * - The view opens on `focus`, and moves to it when it changes to a point out of view.
 */
export function usePanZoom(svgRef: RefObject<SVGSVGElement | null>, width: number, height: number, focus: Point | null) {
  const [box, setBox] = useState<Box | null>(null);
  const [openAt] = useState<Point>(() => focus ?? { x: width / 2, y: height / 2 });
  // The view the reader chose, before it is settled on the box. null until they zoom or pan.
  const [chosen, setChosen] = useState<View | null>(null);
  const [panning, setPanning] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const dropClick = useRef(false);
  const gestureScale = useRef(1);

  const opening: View = { k: OPEN_ZOOM, cx: openAt.x, cy: openAt.y };
  const view = box && settle(chosen ?? opening, box, width, height);
  const minZoom = box ? Math.min(box.w / width, box.h / height, 1) : 1;
  const pannable = !!view && !!box && (box.w / view.k < width - 0.5 || box.h / view.k < height - 0.5);

  // A new focus out of view (a version picked outside the diagram) brings the view to it.
  const focusKey = focus ? `${focus.x},${focus.y}` : "";
  const [answered, setAnswered] = useState(focusKey);
  if (focusKey !== answered) {
    setAnswered(focusKey);
    if (view && box && focus && !inView(view, box, focus)) setChosen({ k: view.k, cx: focus.x, cy: focus.y });
  }

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const svg = svgRef.current;
    if (!svg || !box) return;
    const r = svg.getBoundingClientRect();
    // The pointer's offset from the middle of the box, in pixels. The point under it stays put.
    const px = clientX === undefined ? 0 : clientX - r.left - r.width / 2;
    const py = clientY === undefined ? 0 : clientY - r.top - r.height / 2;
    setChosen((prev) => {
      const v = settle(prev ?? opening, box, width, height);
      const k = settle({ ...v, k: v.k * factor }, box, width, height).k;
      return settle({ k, cx: v.cx + px / v.k - px / k, cy: v.cy + py / v.k - py / k }, box, width, height);
    });
  };
  const panBy = (dx: number, dy: number) => {
    if (!box) return;
    setChosen((prev) => {
      const v = settle(prev ?? opening, box, width, height);
      return settle({ k: v.k, cx: v.cx - dx / v.k, cy: v.cy - dy / v.k }, box, width, height);
    });
  };
  const fitAll = () => setChosen({ k: 0, cx: width / 2, cy: height / 2 });
  const reveal = (p: Point) => {
    if (view && box && !inView(view, box, p)) setChosen({ k: view.k, cx: p.x, cy: p.y });
  };

  const onWheel = useEffectEvent((e: WheelEvent) => {
    if (!box) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.h : 1;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(Math.exp(-clamp(e.deltaY * unit, -25, 25) * 0.01), e.clientX, e.clientY);
      return;
    }
    if (!pannable) return;
    e.preventDefault();
    // Shift + a vertical wheel moves sideways, where the system does not already.
    const sideways = e.shiftKey && e.deltaX === 0;
    panBy(-(sideways ? e.deltaY : e.deltaX) * unit, -(sideways ? 0 : e.deltaY) * unit);
  });
  // Safari's trackpad pinch. A touch pinch is handled by the pointers instead.
  const onGesture = useEffectEvent((e: Event) => {
    e.preventDefault();
    const g = e as Event & { scale: number; clientX: number; clientY: number };
    if (e.type === "gesturechange" && pointers.current.size < 2) zoomAt(g.scale / gestureScale.current, g.clientX, g.clientY);
    gestureScale.current = g.scale;
  });

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry!.contentRect;
      setBox((b) => (w === 0 || h === 0 ? null : b?.w === w && b.h === h ? b : { w, h }));
    });
    ro.observe(svg);
    const wheel = (e: WheelEvent) => onWheel(e);
    const gesture = (e: Event) => onGesture(e);
    svg.addEventListener("wheel", wheel, { passive: false });
    svg.addEventListener("gesturestart", gesture);
    svg.addEventListener("gesturechange", gesture);
    return () => {
      ro.disconnect();
      svg.removeEventListener("wheel", wheel);
      svg.removeEventListener("gesturestart", gesture);
      svg.removeEventListener("gesturechange", gesture);
    };
  }, [svgRef]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const active = pointers.current;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger joins the gesture the first one started.
    if (active.size > 1) return;
    dropClick.current = false;
    let travel = 0;
    const move = (ev: PointerEvent) => {
      const last = active.get(ev.pointerId);
      if (!last) return;
      const now = { x: ev.clientX, y: ev.clientY };
      const other = [...active].find(([id]) => id !== ev.pointerId)?.[1];
      active.set(ev.pointerId, now);
      if (other) {
        // Two fingers: zoom by how far they spread, at their midpoint.
        const before = Math.hypot(last.x - other.x, last.y - other.y);
        const after = Math.hypot(now.x - other.x, now.y - other.y);
        travel = Infinity;
        if (before > 0) zoomAt(after / before, (now.x + other.x) / 2, (now.y + other.y) / 2);
        return;
      }
      travel += Math.abs(now.x - last.x) + Math.abs(now.y - last.y);
      if (travel <= DRAG_PX) return;
      setPanning(true);
      panBy(now.x - last.x, now.y - last.y);
    };
    const up = (ev: PointerEvent) => {
      active.delete(ev.pointerId);
      if (active.size > 0) return;
      // A drag ends in a click on whatever is under the pointer. Drop that click.
      dropClick.current = travel > DRAG_PX;
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const onClickCapture = (e: MouseEvent) => {
    if (!dropClick.current) return;
    dropClick.current = false;
    e.stopPropagation();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomAt(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / ZOOM_STEP);
    else if (e.key === "0") fitAll();
    else return;
    e.preventDefault();
  };

  return {
    viewBox: view && box
      ? `${view.cx - box.w / view.k / 2} ${view.cy - box.h / view.k / 2} ${box.w / view.k} ${box.h / view.k}`
      : `0 0 ${width} ${height}`,
    /** Screen pixels per diagram unit, or null before the box is measured. */
    zoom: view?.k ?? null,
    atMin: !view || view.k <= minZoom * 1.001,
    atMax: !!view && view.k >= MAX_ZOOM * 0.999,
    pannable,
    panning,
    zoomBy: (factor: number) => zoomAt(factor),
    fitAll,
    reveal,
    svgProps: {
      onPointerDown,
      onClickCapture,
      onKeyDown,
      // Once zoomed in, a touch drag pans the tree. Before that it scrolls the page, and a pinch still zooms the tree.
      style: { touchAction: pannable ? "none" : "pan-y" },
    },
  };
}
