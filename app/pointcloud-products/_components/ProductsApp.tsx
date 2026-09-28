"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRODUCTS } from "../_data/products";
import { Legend } from "./panels";
import type { Manifest, MapLayers, ProductData } from "./types";

// Cesium needs the browser; the map is client-only.
const MapView = dynamic(() => import("./MapView"), { ssr: false });

const MANIFEST_URL = "/tonga/products/manifest.json";

/** What each product puts on the map. */
function layersFor(slug: string, d: ProductData | undefined): MapLayers {
  if (!d) return { overlays: [], vectors: [] };
  const o = d.overlays ?? [];
  const v = d.vectors ?? [];
  switch (slug) {
    case "reef-rugosity": return { overlays: o.filter((x) => x.id === "rugosity"), vectors: [] };
    default: return { overlays: o, vectors: v };
  }
}

export default function ProductsApp() {
  const pathname = usePathname();
  const slug = pathname.split("/")[2] || PRODUCTS[0].slug;
  const product = PRODUCTS.find((p) => p.slug === slug) ?? PRODUCTS[0];

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOrtho, setShowOrtho] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(true);

  useEffect(() => {
    fetch(MANIFEST_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} ${MANIFEST_URL}`))))
      .then(setManifest)
      .catch((e) => setError(`Products not built yet (${e.message}). Run scripts/build_products.py.`));
  }, []);

  const data = manifest?.products[product.slug];

  const layers = useMemo(() => layersFor(product.slug, data), [product.slug, data]);
  const legend = product.slug === "reef-rugosity" ? data?.legends?.rugosity : data?.legend;

  return (
    <div className="fixed inset-0 font-sans">
      <MapView bounds={manifest?.bounds ?? null} layers={layers} showOrtho={showOrtho} />

      <aside className="fixed inset-x-0 bottom-0 z-10 flex max-h-[60vh] flex-col rounded-t-xl border border-zinc-300 bg-white/95 text-zinc-700 shadow-lg backdrop-blur md:absolute md:inset-x-auto md:bottom-auto md:left-3 md:top-3 md:max-h-[calc(100vh-1.5rem)] md:w-[22rem] md:rounded-xl">
        <header className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5">
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm font-semibold text-sky-600">Pacific Ocean Portal</p>
            <p className="truncate text-[11px] text-zinc-500">Point cloud products</p>
          </div>
          <Link href="/pointcloud" className="ml-auto shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50">
            3D viewer
          </Link>
          <button type="button" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 md:hidden">
            {sheetOpen ? "Hide" : "Show"}
          </button>
        </header>

        <div className={`${sheetOpen ? "flex" : "hidden"} min-h-0 flex-1 flex-col md:flex`}>
          <nav aria-label="Products" className="border-b border-zinc-200 px-3 py-2">
            <ul className="flex flex-wrap gap-1">
              {PRODUCTS.map((p) => (
                <li key={p.slug}>
                  <Link href={`/pointcloud-products/${p.slug}`} aria-current={p.slug === product.slug ? "page" : undefined}
                    className={`block rounded-md px-2 py-1 text-[11px] transition-colors ${
                      p.slug === product.slug ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                    }`}>
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
            <div>
              <h1 className="text-base font-semibold text-zinc-900">{product.title}</h1>
            </div>

            {error && <p className="rounded-md bg-amber-50 p-2 text-amber-800">{error}</p>}
            {!error && !data && <p className="text-zinc-400">Loading…</p>}
            {data && <Legend legend={legend} />}

            <label className="flex items-center gap-2 text-zinc-600">
              <input type="checkbox" checked={showOrtho} onChange={(e) => setShowOrtho(e.target.checked)} className="h-3.5 w-3.5 accent-blue-600" />
              Orthophoto
            </label>
          </div>
        </div>
      </aside>
    </div>
  );
}
