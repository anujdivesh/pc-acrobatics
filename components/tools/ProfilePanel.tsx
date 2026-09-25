"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as CesiumType from "cesium";
import type { MapHandle } from "../MapProvider";
import { usePointCloud } from "../PointCloudProvider";
import { formatLength } from "@/lib/tools/pick";
import { TwoPointPicker, type PickStage } from "@/lib/tools/twoPoint";
import {
  PROFILE_COLOR, ProfileLine, pointsInCorridor, terrainAlong, type Profile,
} from "@/lib/tools/profile";
import { classLabel } from "@/lib/copc/palette";
import { CloseButton } from "./CloseButton";
import ProfileChart from "./ProfileChart";

const CORRIDORS = [0.5, 1, 2, 5, 10];

export default function ProfilePanel({ map, onClose }: { map: NonNullable<MapHandle>; onClose: () => void }) {
  const { settings, getNodes } = usePointCloud();
  const [stage, setStage] = useState<PickStage>("first");
  const [line, setLine] = useState<ProfileLine | null>(null);
  const [corridor, setCorridor] = useState(1);
  const [profile, setProfile] = useState<Profile | null>(null);
  const pickerRef = useRef<TwoPointPicker | null>(null);
  const corridorEntity = useRef<CesiumType.Entity | null>(null);
  const hoverEntity = useRef<CesiumType.Entity | null>(null);

  useEffect(() => {
    const { cesium, viewer } = map;
    const picker: TwoPointPicker = new TwoPointPicker(cesium, viewer, {
      color: PROFILE_COLOR,
      onStage: (s) => {
        setStage(s);
        if (s !== "done") {
          // The picker has already removed its graphics.
          corridorEntity.current = hoverEntity.current = null;
          setLine(null);
          setProfile(null);
        }
      },
      onComplete: (a, b) => {
        const color = cesium.Color.fromCssColorString(PROFILE_COLOR);
        picker.addEntity({
          polyline: {
            positions: [a.position, b.position],
            width: 3,
            arcType: cesium.ArcType.NONE,
            material: color,
            depthFailMaterial: color.withAlpha(0.45),
          },
        });
        setLine(new ProfileLine(cesium, a, b));
      },
    });
    pickerRef.current = picker;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") picker.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      pickerRef.current = null;
      corridorEntity.current = hoverEntity.current = null;
      picker.destroy();
    };
  }, [map]);

  // The strip the points are taken from, draped on the ground.
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker || !line) return;
    const { cesium } = map;
    const entity = picker.addEntity({
      corridor: {
        positions: [line.a.position, line.b.position],
        width: corridor,
        material: cesium.Color.fromCssColorString(PROFILE_COLOR).withAlpha(0.25),
      },
    });
    corridorEntity.current = entity;
    return () => {
      if (corridorEntity.current === entity) {
        pickerRef.current?.removeEntity(entity);
        corridorEntity.current = null;
      }
    };
  }, [map, line, corridor]);

  const hidden = useMemo(() => new Set(settings.hidden), [settings.hidden]);

  const compute = useCallback(async (l: ProfileLine) => {
    const { points, total } = pointsInCorridor(l, getNodes(), corridor, hidden);
    const terrain = await terrainAlong(map.cesium, map.viewer.terrainProvider, l);
    return { length: l.length, corridor, points, pointsInCorridor: total, terrain };
  }, [map, getNodes, corridor, hidden]);

  useEffect(() => {
    if (!line) return;
    let cancelled = false;
    compute(line).then((p) => {
      if (!cancelled) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [line, compute]);

  // Follow the chart's crosshair on the map.
  const onHover = useCallback((d: number | null, z: number | null) => {
    const picker = pickerRef.current;
    if (!picker || !line) return;
    const { cesium } = map;
    if (d === null || z === null) {
      if (hoverEntity.current) hoverEntity.current.show = false;
      return;
    }
    const carto = line.at(line.length ? d / line.length : 0);
    carto.height = z;
    const position = cesium.Cartographic.toCartesian(carto);
    if (!hoverEntity.current) {
      hoverEntity.current = picker.addEntity({
        position,
        point: {
          pixelSize: 10,
          color: cesium.Color.WHITE,
          outlineColor: cesium.Color.fromCssColorString(PROFILE_COLOR),
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      hoverEntity.current.position = new cesium.ConstantPositionProperty(position);
      hoverEntity.current.show = true;
    }
  }, [map, line]);

  const downloadCsv = () => {
    if (!profile) return;
    const rows = ["source,distance_m,elevation_m,offset_m,class"];
    for (const p of profile.points) {
      rows.push(`lidar,${p.d.toFixed(3)},${p.z.toFixed(3)},${p.offset.toFixed(3)},${classLabel(p.cls)}`);
    }
    for (const t of profile.terrain) rows.push(`terrain,${t.d.toFixed(3)},${t.z.toFixed(3)},,`);
    const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "profile.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="absolute bottom-10 left-1/2 z-20 w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl lg:left-[21.5rem] lg:right-16 lg:w-auto lg:translate-x-0 border border-zinc-300 bg-white/95 p-3 font-sans text-xs text-zinc-600 shadow-lg backdrop-blur">
      <header className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium text-blue-600">Elevation profile</h2>
        {profile && (
          <span className="tabular-nums">
            Length {formatLength(profile.length)}
            {profile.pointsInCorridor > 0 && (
              <> · {profile.pointsInCorridor.toLocaleString()} LiDAR points
                {profile.points.length < profile.pointsInCorridor &&
                  ` (${profile.points.length.toLocaleString()} drawn)`}</>
            )}
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5">
          Corridor width
          <select
            value={corridor}
            onChange={(e) => setCorridor(Number(e.target.value))}
            className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-zinc-800"
          >
            {CORRIDORS.map((c) => (
              <option key={c} value={c}>{c} m</option>
            ))}
          </select>
        </label>
        {profile && (
          <>
            <button
              type="button"
              onClick={() => line && compute(line).then(setProfile)}
              title="Re-read points loaded since, e.g. after zooming in along the line"
              className="rounded-md border border-zinc-300 px-2 py-0.5 text-zinc-700 hover:bg-zinc-100"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={downloadCsv}
              className="rounded-md border border-zinc-300 px-2 py-0.5 text-zinc-700 hover:bg-zinc-100"
            >
              CSV
            </button>
          </>
        )}
        <CloseButton label="Close profile tool" onClick={onClose} />
      </header>

      {stage !== "done" ? (
        <p className="py-2">
          {stage === "first"
            ? "Click the start of the profile line on the point cloud or terrain."
            : "Click the end of the profile line. Esc to cancel."}
        </p>
      ) : !profile ? (
        <p className="py-2">Sampling points and terrain…</p>
      ) : profile.points.length === 0 && profile.terrain.length === 0 ? (
        <p className="py-2">
          Nothing to plot along this line. Turn on the point cloud or terrain layer, or widen the corridor.
        </p>
      ) : (
        <>
          <ProfileChart profile={profile} onHover={onHover} />
          <p className="mt-1 text-zinc-500">
            {settings.enabled
              ? "Points come from what is loaded in view. Zoom in along the line and press Refresh for full density."
              : "Point cloud layer is off, so only the terrain surface is shown."}{" "}
            Click the map to draw a new line.
          </p>
        </>
      )}
    </section>
  );
}
