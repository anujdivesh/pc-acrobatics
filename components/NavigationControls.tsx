"use client";

import { useEffect, useState, type ReactNode } from "react";
import type * as CesiumType from "cesium";
import { useMap, type MapHandle } from "./MapProvider";

type Map = NonNullable<MapHandle>;

const TILT_STEP = 15;
const ROTATE_STEP = 30;
/** Stop short of the horizon: past this the view is mostly sky. */
const MAX_PITCH = -10;
const MIN_PITCH = -90;
const MIN_DISTANCE = 20;

/** The ground point at the centre of the view, which every move pivots on. */
function focusPoint({ cesium: C, viewer }: Map): CesiumType.Cartesian3 {
  const { scene, camera, canvas } = viewer;
  const centre = new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const ray = camera.getPickRay(centre);
  const hit = (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(centre, scene.globe.ellipsoid);
  if (hit) return hit;
  // Looking at the sky: pivot on the ground below the camera instead.
  const below = camera.positionCartographic.clone();
  below.height = 0;
  return C.Cartographic.toCartesian(below);
}

/** Run `step` with the eased fraction added each frame, so moves glide rather than jump. */
function animate(ms: number, step: (fraction: number) => void) {
  const start = performance.now();
  let done = 0;
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    step(eased - done);
    done = eased;
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Orbit the camera about the focus point, in that point's east-north-up frame. */
function orbit(map: Map, move: (camera: CesiumType.Camera, fraction: number) => void) {
  const { cesium: C, viewer } = map;
  const frame = C.Transforms.eastNorthUpToFixedFrame(focusPoint(map));
  animate(300, (fraction) => {
    const { camera } = viewer;
    camera.lookAtTransform(frame);
    move(camera, fraction);
    camera.lookAtTransform(C.Matrix4.IDENTITY);
  });
}

function zoom(map: Map, closer: boolean) {
  const { cesium: C, viewer } = map;
  const distance = C.Cartesian3.distance(viewer.camera.position, focusPoint(map));
  // Halve or double the distance to what is in the middle of the screen.
  const move = closer ? Math.min(distance / 2, distance - MIN_DISTANCE) : -distance;
  if (move <= 0 && closer) return;
  animate(300, (fraction) => viewer.camera.moveForward(move * fraction));
}

function tilt(map: Map, towardHorizon: boolean) {
  const { cesium: C, viewer } = map;
  const pitch = C.Math.toDegrees(viewer.camera.pitch);
  const room = towardHorizon ? MAX_PITCH - pitch : pitch - MIN_PITCH;
  const angle = C.Math.toRadians(Math.max(0, Math.min(TILT_STEP, room)));
  if (!angle) return;
  // Cesium names these from the camera's point of view: rotateDown swings it up
  // over the focus (toward top-down), rotateUp swings it out toward the horizon.
  orbit(map, (camera, f) => (towardHorizon ? camera.rotateUp(angle * f) : camera.rotateDown(angle * f)));
}

function rotate(map: Map, left: boolean) {
  const angle = map.cesium.Math.toRadians(ROTATE_STEP);
  orbit(map, (camera, f) => (left ? camera.rotateLeft(angle * f) : camera.rotateRight(angle * f)));
}

/** North up, looking straight down on the same spot from the same distance. */
function reset(map: Map) {
  const { cesium: C, viewer } = map;
  const focus = focusPoint(map);
  const carto = C.Cartographic.fromCartesian(focus);
  carto.height += C.Cartesian3.distance(viewer.camera.position, focus);
  viewer.camera.flyTo({
    destination: C.Cartographic.toCartesian(carto),
    orientation: { heading: 0, pitch: C.Math.toRadians(MIN_PITCH), roll: 0 },
    duration: 0.8,
  });
}

const icon = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden>
    {children}
  </svg>
);

export default function NavigationControls() {
  const { map } = useMap();
  const [heading, setHeading] = useState(0);
  const [pitch, setPitch] = useState(-90);

  // Keep the compass and the tilt limits in step with the camera, however it moved.
  useEffect(() => {
    if (!map) return;
    const { cesium: C, viewer } = map;
    return viewer.scene.postRender.addEventListener(() => {
      const h = C.Math.toDegrees(viewer.camera.heading);
      const p = C.Math.toDegrees(viewer.camera.pitch);
      setHeading((prev) => (Math.abs(prev - h) > 0.5 ? h : prev));
      setPitch((prev) => (Math.abs(prev - p) > 0.5 ? p : prev));
    });
  }, [map]);

  const buttons: { label: string; onClick: (m: Map) => void; disabled?: boolean; icon: ReactNode }[] = [
    { label: "Zoom in", onClick: (m) => zoom(m, true), icon: icon(<path d="M12 5v14M5 12h14" />) },
    { label: "Zoom out", onClick: (m) => zoom(m, false), icon: icon(<path d="M5 12h14" />) },
    {
      label: "Tilt toward horizon",
      onClick: (m) => tilt(m, true),
      disabled: pitch >= MAX_PITCH - 0.5,
      icon: icon(<><path d="M4 19h16l-4-8H8Z" /><path d="M12 8V3M9.5 5.5 12 3l2.5 2.5" /></>),
    },
    {
      label: "Tilt to top-down",
      onClick: (m) => tilt(m, false),
      disabled: pitch <= MIN_PITCH + 0.5,
      icon: icon(<><rect x="5" y="11" width="14" height="9" rx="1" /><path d="M12 3v5M9.5 5.5 12 8l2.5-2.5" /></>),
    },
    {
      label: "Rotate left",
      onClick: (m) => rotate(m, true),
      icon: icon(<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></>),
    },
    {
      label: "Rotate right",
      onClick: (m) => rotate(m, false),
      icon: icon(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" /></>),
    },
  ];

  return (
    <nav
      aria-label="Map navigation"
      className="flex flex-col gap-0.5 rounded-l-lg border border-r-0 border-zinc-300 bg-white/95 p-1 shadow-lg backdrop-blur"
    >
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          onClick={() => map && b.onClick(map)}
          disabled={!map || b.disabled}
          aria-label={b.label}
          title={b.label}
          className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-900 transition-colors hover:bg-zinc-100 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {b.icon}
        </button>
      ))}
      <div className="mx-1 my-0.5 border-t border-zinc-200" />
      <button
        type="button"
        onClick={() => map && reset(map)}
        disabled={!map}
        aria-label="Reset view: north up, top-down"
        title="Reset view: north up, top-down"
        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-zinc-100 disabled:opacity-30"
      >
        {/* Needle turns with the map, so it always points at true north. */}
        <svg viewBox="0 0 24 24" className="h-5 w-5" style={{ transform: `rotate(${-heading}deg)` }} aria-hidden>
          <circle cx="12" cy="12" r="10" fill="none" stroke="#d4d4d8" strokeWidth="1.5" />
          <path d="M12 3.5 15 12H9Z" fill="#dc2626" />
          <path d="M12 20.5 9 12h6Z" fill="#52525b" />
        </svg>
      </button>
    </nav>
  );
}
