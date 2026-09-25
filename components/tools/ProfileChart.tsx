"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SERIES, type Profile, type ProfilePoint } from "@/lib/tools/profile";
import { formatLength } from "@/lib/tools/pick";
import { classLabel } from "@/lib/copc/palette";

const HEIGHT = 220;
const M = { top: 10, right: 14, bottom: 28, left: 52 };

/** Round tick values covering [min, max]. */
function ticks(min: number, max: number, count: number) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
  return { values: out, step };
}

const fmtTick = (v: number, step: number) => v.toFixed(Math.max(0, -Math.floor(Math.log10(step))));

type Props = {
  profile: Profile;
  /** Crosshair position along the line, and the elevation there. */
  onHover: (d: number | null, z: number | null) => void;
};

export default function ProfileChart({ profile, onHover }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<{ x: number; d: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(50, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;

  const scale = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const p of profile.points) { lo = Math.min(lo, p.z); hi = Math.max(hi, p.z); }
    for (const t of profile.terrain) { lo = Math.min(lo, t.z); hi = Math.max(hi, t.z); }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    const pad = Math.max(0.5, (hi - lo) * 0.06);
    const yMin = lo - pad, yMax = hi + pad;
    const length = profile.length || 1;
    return {
      x: (d: number) => M.left + (d / length) * plotW,
      xInv: (x: number) => ((x - M.left) / plotW) * length,
      y: (z: number) => M.top + (1 - (z - yMin) / (yMax - yMin)) * plotH,
      yMin, yMax, length, lo, hi,
      // Metres per pixel across vs up: how stretched the vertical is.
      exaggeration: (length / plotW) / ((yMax - yMin) / plotH),
    };
  }, [profile, plotW, plotH]);

  // Points on a canvas: tens of thousands of SVG nodes would crawl.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = SERIES.points;
    ctx.globalAlpha = profile.points.length > 5000 ? 0.45 : 0.75;
    const r = profile.points.length > 5000 ? 1.2 : 1.8;
    for (const p of profile.points) {
      ctx.beginPath();
      ctx.arc(scale.x(p.d), scale.y(p.z), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [profile, scale, width]);

  // Points sorted by distance, for the nearest-point lookup under the crosshair.
  const sorted = useMemo(() => [...profile.points].sort((p, q) => p.d - q.d), [profile.points]);

  const readout = useMemo(() => {
    if (!hover) return null;
    const { d } = hover;
    // Terrain: linear between the two samples either side.
    let terrain: number | null = null;
    const t = profile.terrain;
    for (let i = 1; i < t.length; i++) {
      if (t[i].d >= d) {
        const f = (d - t[i - 1].d) / (t[i].d - t[i - 1].d || 1);
        terrain = t[i - 1].z + f * (t[i].z - t[i - 1].z);
        break;
      }
    }
    // LiDAR: the point closest in distance, if one is within 4 px.
    let nearest: ProfilePoint | null = null;
    if (sorted.length) {
      let lo = 0, hi = sorted.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].d < d) lo = mid + 1; else hi = mid;
      }
      const tol = (4 / plotW) * scale.length;
      const cands = [sorted[lo - 1], sorted[lo]].filter(Boolean);
      const best = cands.reduce((a, b) => (Math.abs(b.d - d) < Math.abs(a.d - d) ? b : a));
      if (Math.abs(best.d - d) <= tol) nearest = best;
    }
    return { d, terrain, nearest };
  }, [hover, profile.terrain, sorted, plotW, scale.length]);

  useEffect(() => {
    onHover(readout?.d ?? null, readout ? readout.nearest?.z ?? readout.terrain : null);
  }, [readout, onHover]);

  const xt = ticks(0, scale.length, Math.max(2, Math.floor(plotW / 90)));
  const yt = ticks(scale.yMin, scale.yMax, 4);
  const terrainPath = profile.terrain
    .map((t, i) => `${i ? "L" : "M"}${scale.x(t.d).toFixed(1)},${scale.y(t.z).toFixed(1)}`)
    .join("");
  const hasPoints = profile.points.length > 0;
  const hasTerrain = profile.terrain.length > 0;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-zinc-600">
        {hasPoints && (
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: SERIES.points }} />
            LiDAR points
          </span>
        )}
        {hasTerrain && (
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: SERIES.terrain }} />
            Terrain surface
          </span>
        )}
        <span className="ml-auto tabular-nums text-zinc-500">
          Min {formatLength(scale.lo)} · Max {formatLength(scale.hi)} · Relief {formatLength(scale.hi - scale.lo)}
          {" · "}vertical ×{scale.exaggeration.toFixed(scale.exaggeration < 10 ? 1 : 0)}
        </span>
      </div>

      <div ref={wrapRef} className="relative" style={{ height: HEIGHT }}>
        <canvas ref={canvasRef} className="absolute inset-0" style={{ width, height: HEIGHT }} />
        <svg
          width={width}
          height={HEIGHT}
          className="absolute inset-0"
          role="img"
          aria-label={`Elevation profile, ${formatLength(scale.length)} long, from ${formatLength(scale.lo)} to ${formatLength(scale.hi)}`}
          onMouseMove={(e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
            if (x < M.left || x > M.left + plotW) return setHover(null);
            setHover({ x, d: scale.xInv(x) });
          }}
          onMouseLeave={() => setHover(null)}
        >
          {/* grid + axes, recessive */}
          {yt.values.map((v) => (
            <g key={`y${v}`}>
              <line x1={M.left} x2={M.left + plotW} y1={scale.y(v)} y2={scale.y(v)} stroke="#e4e4e7" />
              <text x={M.left - 6} y={scale.y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="#71717a">
                {fmtTick(v, yt.step)}
              </text>
            </g>
          ))}
          {xt.values.map((v) => (
            <text key={`x${v}`} x={scale.x(v)} y={HEIGHT - M.bottom + 14} textAnchor="middle" fontSize={10} fill="#71717a">
              {fmtTick(v, xt.step)}
            </text>
          ))}
          <line x1={M.left} x2={M.left + plotW} y1={M.top + plotH} y2={M.top + plotH} stroke="#a1a1aa" />
          <text x={M.left + plotW} y={HEIGHT - 2} textAnchor="end" fontSize={10} fill="#71717a">Distance (m)</text>
          <text x={12} y={M.top + plotH / 2} textAnchor="middle" fontSize={10} fill="#71717a"
            transform={`rotate(-90 12 ${M.top + plotH / 2})`}>Elevation (m)</text>

          {hasTerrain && (
            <path d={terrainPath} fill="none" stroke={SERIES.terrain} strokeWidth={2} strokeLinejoin="round" />
          )}

          {readout && hover && (
            <g pointerEvents="none">
              <line x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + plotH} stroke="#52525b" strokeDasharray="3 3" />
              {readout.terrain !== null && (
                <circle cx={hover.x} cy={scale.y(readout.terrain)} r={4} fill={SERIES.terrain} stroke="#fff" strokeWidth={2} />
              )}
              {readout.nearest && (
                <circle cx={scale.x(readout.nearest.d)} cy={scale.y(readout.nearest.z)} r={4.5}
                  fill={SERIES.points} stroke="#fff" strokeWidth={2} />
              )}
            </g>
          )}
        </svg>

        {readout && hover && (
          <div
            className="pointer-events-none absolute top-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[11px] leading-4 text-zinc-600 shadow"
            style={hover.x > width / 2 ? { right: width - hover.x + 10 } : { left: hover.x + 10 }}
          >
            <div className="font-medium tabular-nums text-zinc-900">{formatLength(readout.d)} along</div>
            {readout.nearest && (
              <div className="tabular-nums">
                LiDAR {formatLength(readout.nearest.z)}
                <span className="text-zinc-400"> · {classLabel(readout.nearest.cls)}</span>
              </div>
            )}
            {readout.terrain !== null && (
              <div className="tabular-nums">Terrain {formatLength(readout.terrain)}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
