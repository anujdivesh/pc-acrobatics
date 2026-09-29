#!/usr/bin/env python
"""
Merge the cleaned topographic and bathymetric DEMs into one topobathy DEM.

    elevation/SPCTonga2026-DEM-1m-001.tif  (topo, 1 m)  --+
                                                          +--> elevation/build/topobathy_dem.tif
    elevation/SPCTonga2026-DEM-5m-001.tif  (bathy, 5 m) --+

The output covers the union of both extents on the topo's grid (1 m by default).
Topo wins wherever it has data; bathy is resampled (bilinear) onto the same grid
and fills everything else. Across a narrow band just inside the topo's edge the
two are blended, so the shoreline has no step where one survey hands over to the
other. Pinholes left between the two are filled from their neighbours; larger
gaps stay nodata (the terrain tiler interpolates those).

Heights are copied as stored: both DEMs are ellipsoidal, matching the COPC.

Run in the `pcl` environment:

    micromamba run -n pcl python scripts/merge_elevation.py
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from osgeo import gdal
from scipy import ndimage

gdal.UseExceptions()

HERE = Path(__file__).resolve().parent
NODATA = -9999.0


def read_on_grid(path: Path, bounds, res: float, srs_wkt: str, alg: str) -> np.ndarray:
    ds = gdal.Warp("", str(path), format="MEM", outputBounds=bounds, xRes=res, yRes=res,
                   dstSRS=srs_wkt, resampleAlg=alg, dstNodata=NODATA, outputType=gdal.GDT_Float32)
    arr = ds.GetRasterBand(1).ReadAsArray()
    ds = None
    return arr


def extent(ds: gdal.Dataset) -> tuple[float, float, float, float]:
    gt = ds.GetGeoTransform()
    x0, y1 = gt[0], gt[3]
    return x0, y1 + ds.RasterYSize * gt[5], x0 + ds.RasterXSize * gt[1], y1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--topo", type=Path, default=HERE / "elevation/SPCTonga2026-DEM-1m-001.tif")
    ap.add_argument("--bathy", type=Path, default=HERE / "elevation/SPCTonga2026-DEM-5m-001.tif")
    ap.add_argument("--out", type=Path, default=HERE / "elevation/build/topobathy_dem.tif")
    ap.add_argument("--resolution", type=float, default=None,
                    help="output cell size in metres (default: the topo's)")
    ap.add_argument("--feather", type=float, default=10.0,
                    help="width in metres of the topo-to-bathy blend inside the topo's edge")
    ap.add_argument("--fill-px", type=int, default=5,
                    help="largest hole, in cells, filled from its neighbours")
    args = ap.parse_args()

    topo_ds, bathy_ds = gdal.Open(str(args.topo)), gdal.Open(str(args.bathy))
    srs_wkt = topo_ds.GetProjection()
    res = args.resolution or abs(topo_ds.GetGeoTransform()[1])

    # Union of both extents, snapped outward to the output grid.
    tb, bb = extent(topo_ds), extent(bathy_ds)
    bounds = (math.floor(min(tb[0], bb[0]) / res) * res, math.floor(min(tb[1], bb[1]) / res) * res,
              math.ceil(max(tb[2], bb[2]) / res) * res, math.ceil(max(tb[3], bb[3]) / res) * res)
    topo_ds = bathy_ds = None
    w, h = round((bounds[2] - bounds[0]) / res), round((bounds[3] - bounds[1]) / res)
    print(f"[1/3] reading onto a {w} x {h} grid at {res:g} m", flush=True)

    topo = read_on_grid(args.topo, bounds, res, srs_wkt, "average" if res > 1 else "bilinear")
    bathy = read_on_grid(args.bathy, bounds, res, srs_wkt, "bilinear")
    has_topo, has_bathy = topo != NODATA, bathy != NODATA

    # Weight ramps from 0 at the topo's edge to 1 `feather` metres inside it,
    # and only where bathy is there to blend with.
    print(f"[2/3] merging, {args.feather:g} m blend at the topo edge", flush=True)
    dist = ndimage.distance_transform_edt(has_topo) * res
    t = np.clip(dist / args.feather, 0.0, 1.0) if args.feather > 0 else np.ones_like(dist)
    wt = np.where(has_bathy, t * t * (3.0 - 2.0 * t), 1.0)
    merged = np.where(has_topo, wt * topo + (1.0 - wt) * np.where(has_bathy, bathy, 0.0), bathy)
    merged = np.where(has_topo | has_bathy, merged, NODATA).astype(np.float32)
    overlap = int(np.count_nonzero(has_topo & has_bathy))
    if overlap:
        d = (topo - bathy)[has_topo & has_bathy]
        print(f"       overlap {overlap:,} cells, topo - bathy median {np.median(d):+.2f} m", flush=True)
    del topo, bathy, dist, t, wt

    print(f"[3/3] filling holes up to {args.fill_px} cells, writing {args.out}", flush=True)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    ds = gdal.GetDriverByName("GTiff").Create(
        str(args.out), w, h, 1, gdal.GDT_Float32,
        ["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES", "BIGTIFF=IF_SAFER"])
    ds.SetGeoTransform((bounds[0], res, 0.0, bounds[3], 0.0, -res))
    ds.SetProjection(srs_wkt)
    band = ds.GetRasterBand(1)
    band.SetNoDataValue(NODATA)
    band.WriteArray(merged)
    if args.fill_px > 0:
        gdal.FillNodata(band, None, maxSearchDist=args.fill_px, smoothingIterations=0)
    stats = band.ComputeStatistics(False)
    # Averaged overviews, so coarse terrain levels read a downsampled surface.
    ds.BuildOverviews("AVERAGE", [2, 4, 8, 16, 32, 64, 128])
    ds = None
    print(f"       heights {stats[0]:.2f} to {stats[1]:.2f} m, "
          f"{np.count_nonzero(merged != NODATA) / merged.size:.1%} of the grid has data", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
