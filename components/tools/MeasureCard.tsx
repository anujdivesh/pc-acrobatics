"use client";

import { useEffect, useRef, useState } from "react";
import type { MapHandle } from "../MapProvider";
import { MEASURE_COLOR, drawMeasurement, measure, type Measurement } from "@/lib/tools/measure";
import { SOURCE_LABEL, formatLength, formatSigned } from "@/lib/tools/pick";
import { TwoPointPicker, type PickStage } from "@/lib/tools/twoPoint";
import { CloseButton } from "./CloseButton";

export default function MeasureCard({ map, onClose }: { map: NonNullable<MapHandle>; onClose: () => void }) {
  const [stage, setStage] = useState<PickStage>("first");
  const [result, setResult] = useState<Measurement | null>(null);
  const pickerRef = useRef<TwoPointPicker | null>(null);

  useEffect(() => {
    const { cesium, viewer } = map;
    const picker: TwoPointPicker = new TwoPointPicker(cesium, viewer, {
      color: MEASURE_COLOR,
      onStage: (s) => {
        setStage(s);
        if (s !== "done") setResult(null);
      },
      onComplete: (a, b) => {
        const m = measure(cesium, a, b);
        drawMeasurement(cesium, picker, a, b, m);
        setResult(m);
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
      picker.destroy();
    };
  }, [map]);

  return (
    <section className="w-60 rounded-xl border border-zinc-300 bg-white/95 p-3 text-xs text-zinc-600 shadow-lg backdrop-blur">
      <header className="mb-2 flex items-center">
        <h2 className="text-sm font-medium text-blue-600">Measure distance</h2>
        <CloseButton label="Close measure tool" onClick={onClose} />
      </header>

      {stage === "done" && result ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-zinc-100 px-3 py-2">
            <dt>Distance</dt>
            <dd className="text-right font-medium tabular-nums text-zinc-900">
              {formatLength(result.distance)}
            </dd>
            <dt>Horizontal</dt>
            <dd className="text-right tabular-nums text-zinc-900">{formatLength(result.horizontal)}</dd>
            <dt>Height change</dt>
            <dd className="text-right tabular-nums text-zinc-900">{formatSigned(result.vertical)}</dd>
          </dl>
          <p className="mt-2 text-zinc-500">
            {SOURCE_LABEL[result.from]} → {SOURCE_LABEL[result.to]}
          </p>
          <div className="mt-2 flex items-center">
            <p className="text-zinc-500">Click to start again.</p>
            <button
              type="button"
              onClick={() => pickerRef.current?.clear()}
              className="ml-auto rounded-md border border-zinc-300 px-2 py-1 text-zinc-700 hover:bg-zinc-100"
            >
              Clear
            </button>
          </div>
        </>
      ) : (
        <p>
          {stage === "first"
            ? "Click the first point on the point cloud or terrain."
            : "Click the second point. Esc to cancel."}
        </p>
      )}
    </section>
  );
}
