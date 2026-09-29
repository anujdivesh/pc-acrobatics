#!/usr/bin/env python
"""
Build Cesium quantized-mesh terrain from a DEM GeoTIFF (no point cloud needed).

    elevation/build/topobathy_dem.tif  --> elevation/build/terrain.pmtiles

Run merge_elevation.py first to produce the DEM. The archive has the same layout
and metadata as build_cesium_terrain.py writes, so it drops in for
public/tonga/terrain.pmtiles. Meshing, gap filling and the PMTiles writer are
shared with that script.

Heights are the DEM's values, untouched, read as metres above the WGS84 ellipsoid.

Run in the `pcl` environment:

    micromamba run -n pcl python scripts/build_elevation_terrain.py
"""

from __future__ import annotations

import argparse
import os
from datetime import date
from pathlib import Path

import numpy as np
from osgeo import gdal, osr

from build_cesium_terrain import NODATA, build_tiles

gdal.UseExceptions()

HERE = Path(__file__).resolve().parent


def terrain_meta(dem: Path, maxzoom: int, resolution: float, water: float | None) -> dict:
    """What the viewer shows and frames from: extent, resolution, height statistics."""
    ds = gdal.Open(str(dem))
    band = ds.GetRasterBand(1)
    arr = band.GetOverview(min(2, band.GetOverviewCount() - 1)).ReadAsArray() \
        if band.GetOverviewCount() else band.ReadAsArray()
    v = arr[arr != NODATA].astype(np.float64)
    gt, xs, ys = ds.GetGeoTransform(), ds.RasterXSize, ds.RasterYSize
    srs = osr.SpatialReference(wkt=ds.GetProjection())
    merc = osr.SpatialReference()
    merc.ImportFromEPSG(3857)
    for sr in (srs, merc):
        sr.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(srs, merc)
    pts = [tr.TransformPoint(gt[0] + px * gt[1], gt[3] + py * gt[5])[:2]
           for px in (0, xs / 2, xs) for py in (0, ys / 2, ys)]
    ds = None
    return {
        "minzoom": 0,
        "maxzoom": maxzoom,
        "resolution": resolution,
        # None lets the viewer fall back to the median height.
        "waterLevel": water,
        "elevation": {"min": float(v.min()), "max": float(v.max()),
                      "mean": float(v.mean()), "median": float(np.median(v))},
        "bounds3857": [min(p[0] for p in pts), min(p[1] for p in pts),
                       max(p[0] for p in pts), max(p[1] for p in pts)],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dem", type=Path, default=HERE / "elevation/build/topobathy_dem.tif")
    ap.add_argument("--out", type=Path, default=HERE / "elevation/build/terrain.pmtiles")
    ap.add_argument("--maxzoom", type=int, default=18,
                    help="z18 puts terrain posts about 1.2 m apart, matching a 1 m DEM")
    ap.add_argument("--error", type=float, default=0.025,
                    help="mesh simplification tolerance in metres (worst case ~1.7x this)")
    ap.add_argument("--fill", type=float, default=None,
                    help="far-field height well outside the survey (default: median "
                         "height along the survey's edge)")
    ap.add_argument("--water-level", type=float, default=None,
                    help="water surface height in metres, stored for the viewer")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()

    if not args.dem.exists():
        print(f"error: {args.dem} not found; run merge_elevation.py first")
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    ds = gdal.Open(str(args.dem))
    resolution = abs(ds.GetGeoTransform()[1])
    ds = None

    def describe(result: dict) -> dict:
        return {
            "built": date.today().isoformat(),
            "source": args.dem.name,
            "dem_resolution_m": resolution,
            "dem_method": "cleaned topo (1 m) + bathy (5 m) DEMs, merged by merge_elevation.py",
            "gaps": "cells with no data: interpolated from surrounding data (pull-push, 5 m); "
                    "outside the survey, eased over 3 km to the far-field height. "
                    "Surveyed cells are never altered.",
            "heights": "DEM values as stored, read as metres above the WGS84 ellipsoid; "
                       "no scaling, offset or exaggeration",
            "maxzoom": args.maxzoom,
            "mesh_error_m": args.error,
            "terrainMeta": terrain_meta(args.dem, args.maxzoom, resolution, args.water_level),
            **result,
        }

    # build_tiles writes its gap-fill surface next to the DEM.
    result = build_tiles(args.dem, args.out, "pmtiles", args.maxzoom, args.error, args.fill,
                         args.workers, describe)
    print(f"[4/4] {result['tiles']:,} tiles, {result['bytes'] / 1e6:.0f} MB -> {args.out}",
          flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
