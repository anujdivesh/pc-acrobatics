#!/usr/bin/env python
"""
Build the point cloud products shown at /pointcloud-products.

    topobathy.copc.laz --PDAL--> 1 m grids (ground, seabed, surface)
                       --> public/tonga/products/  (map overlays, GeoJSON, manifest.json)

Every height is relative to the water level measured in the survey (median of the
water-surface returns), so 0 is the sea surface at survey time -- not a tidal datum.

Products: hypsometry, bathymetry,
reef rugosity and slope, canopy height and trees, tsunami safe zones, drainage.

Run in the `pcl` environment:

    micromamba run -n pcl python scripts/build_products.py

Grids are cached in .products-build/; `--regrid` rebuilds them from the COPC.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import matplotlib
import numpy as np
import pdal
from osgeo import gdal
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon, mapping
from shapely.ops import transform as shp_transform
from skimage import feature, measure, morphology, segmentation

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_cesium_terrain import water_level  # noqa: E402

gdal.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
NODATA = -9999.0
RES = 1.0            # analysis grid, metres
DISPLAY_RES = 2.0    # map overlays, metres
URL_BASE = "/tonga/products"


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# Grids
# --------------------------------------------------------------------------

@dataclass
class Grid:
    x0: float
    y1: float
    width: int
    height: int
    res: float
    wkt: str

    @property
    def gt(self):
        return (self.x0, self.res, 0.0, self.y1, 0.0, -self.res)

    def xy(self, rows, cols):
        """Pixel centres (row, col may be fractional) -> projected x, y."""
        return self.x0 + (np.asarray(cols) + 0.5) * self.res, self.y1 - (np.asarray(rows) + 0.5) * self.res

    def rc(self, x, y):
        return (self.y1 - np.asarray(y)) / self.res - 0.5, (np.asarray(x) - self.x0) / self.res - 0.5


def make_grid(src: Path, res: float) -> Grid:
    info = json.loads(subprocess.run(["pdal", "info", "--metadata", str(src)], check=True,
                                     capture_output=True, text=True).stdout)["metadata"]
    x0 = math.floor(info["minx"] / res) * res
    y0 = math.floor(info["miny"] / res) * res
    w = math.ceil((info["maxx"] - x0) / res) + 1
    h = math.ceil((info["maxy"] - y0) / res) + 1
    wkt = info["srs"]["wkt"] if isinstance(info.get("srs"), dict) else info["comp_spatialreference"]
    return Grid(x0, y0 + h * res, w, h, res, wkt)


def _grid_block(job: tuple) -> str:
    src, out, x0, y0, w, h, res, classes, stat = job
    expr = " || ".join(f"Classification == {c}" for c in classes)
    pipeline = [
        {"type": "readers.copc", "filename": str(src),
         "bounds": f"([{x0},{x0 + w * res}],[{y0},{y0 + h * res}])", "threads": 2},
        {"type": "filters.expression", "expression": expr},
        {"type": "writers.gdal", "filename": str(out), "resolution": res, "output_type": stat,
         # Each point counts toward the one cell it falls in: no smoothing across cells.
         "binmode": True, "window_size": 0,
         "origin_x": x0, "origin_y": y0, "width": w, "height": h,
         "data_type": "float32", "nodata": NODATA, "gdaldriver": "GTiff",
         "gdalopts": "COMPRESS=DEFLATE,PREDICTOR=3,TILED=YES"},
    ]
    pdal.Pipeline(json.dumps(pipeline)).execute()
    return str(out)


def grid_classes(src: Path, grid: Grid, classes: list[int], stat: str, work: Path, name: str,
                 workers: int, regrid: bool) -> np.ndarray:
    """One statistic of the given classes per cell, NaN where no point fell."""
    path = work / f"{name}.tif"
    if regrid or not path.exists():
        blocks = work / f"blocks-{name}"
        shutil.rmtree(blocks, ignore_errors=True)
        blocks.mkdir(parents=True)
        step = int(2000 / grid.res)
        y0 = grid.y1 - grid.height * grid.res
        jobs = [(src, blocks / f"b_{bx}_{by}.tif", grid.x0 + bx * grid.res, y0 + by * grid.res,
                 min(step, grid.width - bx), min(step, grid.height - by), grid.res, classes, stat)
                for by in range(0, grid.height, step) for bx in range(0, grid.width, step)]
        t = time.time()
        with ProcessPoolExecutor(workers) as pool:
            files = list(pool.map(_grid_block, jobs))
        for f in files:  # empty blocks come back without a CRS
            ds = gdal.Open(f, gdal.GA_Update)
            ds.SetProjection(grid.wkt)
            ds = None
        vrt = gdal.BuildVRT("", files)
        gdal.Translate(str(path), vrt, noData=NODATA,
                       creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES", "BIGTIFF=IF_SAFER"])
        vrt = None
        shutil.rmtree(blocks)
        log(f"       gridded {name}: classes {classes}, {stat} ({time.time() - t:.0f}s)")
    arr = gdal.Open(str(path)).ReadAsArray().astype(np.float32)
    arr[arr == NODATA] = np.nan
    return arr


def fill_holes(arr: np.ndarray, grid: Grid, max_px: int) -> np.ndarray:
    """Fill NaN gaps up to `max_px` cells from data, inverse-distance from their edges."""
    h, w = arr.shape
    mem = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Float32)
    mem.SetGeoTransform(grid.gt)
    band = mem.GetRasterBand(1)
    band.SetNoDataValue(NODATA)
    band.WriteArray(np.where(np.isnan(arr), NODATA, arr))
    gdal.FillNodata(band, None, maxSearchDist=max_px, smoothingIterations=0)
    out = band.ReadAsArray().astype(np.float32)
    out[out == NODATA] = np.nan
    return out


def nan_filter(arr: np.ndarray, fn, **kw) -> np.ndarray:
    """Apply a linear filter ignoring NaNs (normalised convolution)."""
    valid = ~np.isnan(arr)
    num = fn(np.where(valid, arr, 0.0).astype(np.float64), **kw)
    den = fn(valid.astype(np.float64), **kw)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[~valid] = np.nan
    return out.astype(np.float32)


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------

def hexc(rgb) -> str:
    return "#{:02x}{:02x}{:02x}".format(*(int(round(c * 255)) for c in rgb[:3]))


def ramp(values: np.ndarray, vmin: float, vmax: float, cmap: str, mask: np.ndarray, alpha: int = 235):
    """Continuous colour ramp -> RGBA, plus legend stops."""
    cm = matplotlib.colormaps[cmap]
    t = np.clip((np.nan_to_num(values, nan=vmin) - vmin) / (vmax - vmin), 0, 1)
    rgba = (cm(t) * 255).astype(np.uint8)
    rgba[..., 3] = np.where(mask, alpha, 0)
    stops = [[round(vmin + f * (vmax - vmin), 2), hexc(cm(f))] for f in np.linspace(0, 1, 6)]
    return rgba, {"type": "ramp", "stops": stops}


def bands(values: np.ndarray, edges: list[float], colors: list[str], mask: np.ndarray,
          labels: list[str], alpha: int = 235):
    """Discrete classes -> RGBA, plus legend entries."""
    rgba = np.zeros(values.shape + (4,), np.uint8)
    idx = np.digitize(np.nan_to_num(values, nan=-1e9), edges) - 1
    for i, c in enumerate(colors):
        sel = mask & (idx == i)
        rgb = [int(c[k:k + 2], 16) for k in (1, 3, 5)]
        rgba[sel, :3] = rgb
        rgba[sel, 3] = alpha
    return rgba, {"type": "classes", "items": [[lab, col] for lab, col in zip(labels, colors)]}


class Writer:
    def __init__(self, grid: Grid, out: Path):
        self.grid = grid
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self.to_ll = Transformer.from_crs(grid.wkt, "EPSG:4326", always_xy=True).transform
        lat = self.to_ll(grid.x0 + grid.width * grid.res / 2, grid.y1 - grid.height * grid.res / 2)[1]
        self.dlat = DISPLAY_RES / 110_574
        self.dlon = DISPLAY_RES / (111_320 * math.cos(math.radians(lat)))

    def overlay(self, name: str, rgba: np.ndarray, label: str) -> dict:
        """An RGBA grid, reprojected to lon/lat and cropped, as a PNG for the map."""
        h, w = rgba.shape[:2]
        mem = gdal.GetDriverByName("MEM").Create("", w, h, 4, gdal.GDT_Byte)
        mem.SetGeoTransform(self.grid.gt)
        mem.SetProjection(self.grid.wkt)
        for i in range(4):
            mem.GetRasterBand(i + 1).WriteArray(rgba[..., i])
        mem.GetRasterBand(4).SetColorInterpretation(gdal.GCI_AlphaBand)
        warped = gdal.Warp("", mem, format="MEM", dstSRS="EPSG:4326", xRes=self.dlon, yRes=self.dlat,
                           resampleAlg="average", srcAlpha=True, dstAlpha=True)
        img = np.dstack([warped.GetRasterBand(i + 1).ReadAsArray() for i in range(4)])
        gt = warped.GetGeoTransform()
        rows = np.nonzero(img[..., 3].any(axis=1))[0]
        cols = np.nonzero(img[..., 3].any(axis=0))[0]
        if rows.size == 0:
            rows, cols = np.array([0, 0]), np.array([0, 0])
        r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
        img = img[r0:r1, c0:c1]
        west, north = gt[0] + c0 * gt[1], gt[3] + r0 * gt[5]
        east, south = gt[0] + c1 * gt[1], gt[3] + r1 * gt[5]
        # A 256-colour palette keeps the ramps smooth at a fraction of the size.
        Image.fromarray(img, "RGBA").quantize(256, method=Image.Quantize.FASTOCTREE).save(
            self.out / f"{name}.png", optimize=True)
        return {"id": name, "label": label, "url": f"{URL_BASE}/{name}.png",
                "rect": [round(west, 7), round(south, 7), round(east, 7), round(north, 7)]}

    def geojson(self, name: str, features: list[tuple], label: str, style: dict) -> dict:
        """(shapely geometry in the grid CRS, properties) pairs -> lon/lat GeoJSON."""
        def rnd(obj):
            if isinstance(obj, (list, tuple)):
                if obj and isinstance(obj[0], (int, float)):
                    return [round(float(v), 6) for v in obj]
                return [rnd(o) for o in obj]
            return obj
        feats = []
        for geom, props in features:
            g = mapping(shp_transform(self.to_ll, geom))
            g["coordinates"] = rnd(g["coordinates"])
            feats.append({"type": "Feature", "geometry": g, "properties": props})
        path = self.out / f"{name}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
        return {"id": name, "label": label, "url": f"{URL_BASE}/{name}.geojson", "style": style,
                "count": len(feats)}

    def json(self, name: str, data) -> str:
        (self.out / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")))
        return f"{URL_BASE}/{name}.json"


def contour_lines(arr: np.ndarray, grid: Grid, level: float, min_len: float, simplify: float):
    lines = []
    for c in measure.find_contours(arr, level):
        if len(c) < 2:
            continue
        x, y = grid.xy(c[:, 0], c[:, 1])
        line = LineString(np.column_stack([x, y])).simplify(simplify)
        if line.length >= min_len:
            lines.append(line)
    return lines


def ha(cells: int | float, res: float = RES) -> float:
    return round(float(cells) * res * res / 10_000, 2)


# --------------------------------------------------------------------------
# Products
# --------------------------------------------------------------------------

def hypsometry(g: Grid, W: Writer, ground, land):
    h = ground[land]
    edges = np.arange(0, math.ceil(float(h.max())) + 0.5, 0.5)
    counts, _ = np.histogram(h, bins=edges)
    cum = np.concatenate([[0], np.cumsum(counts)]) / h.size * 100
    below = {str(t): round(float((h < t).mean() * 100), 1) for t in (1, 2, 5, 10)}
    band_edges = [0, 1, 2, 5, 10, 20, 1e9]
    colors = ["#fff7bc", "#fee391", "#fec44f", "#fe9929", "#d95f0e", "#993404"]
    labels = ["0–1 m", "1–2 m", "2–5 m", "5–10 m", "10–20 m", "> 20 m"]
    rgba, legend = bands(ground, band_edges, colors, land, labels)
    return {
        "overlays": [W.overlay("hypsometry", rgba, "Height above sea level")],
        "legend": legend,
        "stats": {"land_ha": ha(land.sum()), "max_m": round(float(h.max()), 2),
                  "mean_m": round(float(h.mean()), 2), "median_m": round(float(np.median(h)), 2),
                  "pct_below": below,
                  "curve": [[round(float(e), 2), round(float(c), 2)] for e, c in zip(edges, cum)]},
    }


def bathymetry(g: Grid, W: Writer, seabed):
    depth = -seabed
    valid = ~np.isnan(depth)
    under = valid & (depth > 0)
    rgba, legend = ramp(depth, 0, 40, "Blues", valid)
    legend["label"] = "Depth (m)"
    smooth = nan_filter(depth, ndimage.gaussian_filter, sigma=2.0)
    iso = []
    for level in (2, 5, 10, 20, 30):
        for line in contour_lines(np.nan_to_num(smooth, nan=-99), g, level, 60, 1.0):
            iso.append((line, {"depth_m": level}))
    d = depth[under]
    edges = [0, 2, 5, 10, 20, 1e9]
    names = ["0–2 m", "2–5 m", "5–10 m", "10–20 m", "> 20 m"]
    by_band = [{"band": n, "ha": ha(((d >= lo) & (d < hi)).sum())} for n, lo, hi in zip(names, edges, edges[1:])]
    return {
        "overlays": [W.overlay("depth", rgba, "Depth")],
        "vectors": [W.geojson("isobaths", iso, "Depth contours", {"stroke": "#1e3a8a", "width": 1})],
        "legend": legend,
        "stats": {"seabed_ha": ha(valid.sum()), "max_depth_m": round(float(d.max()), 2),
                  "mean_depth_m": round(float(d.mean()), 2), "drying_ha": ha((valid & ~under).sum()),
                  "by_depth": by_band},
    }


def rugosity(g: Grid, W: Writer, seabed):
    valid = ~np.isnan(seabed)
    gy, gx = np.gradient(np.where(valid, seabed, np.nan), g.res)
    ratio = np.sqrt(1 + gx ** 2 + gy ** 2)
    rug = nan_filter(ratio.astype(np.float32), ndimage.uniform_filter, size=5)
    slope = np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32)
    ok = valid & ~np.isnan(rug)
    rug_rgba, rug_legend = ramp(rug, 1.0, 1.2, "Oranges", ok)
    rug_legend["label"] = "Rugosity (1 = flat)"
    slope_rgba, slope_legend = ramp(slope, 0, 40, "Purples", valid & ~np.isnan(slope))
    slope_legend["label"] = "Slope (degrees)"
    depth = -seabed
    zones = []
    for name, lo, hi in (("Reef flat (< 2 m)", -99, 2), ("2–10 m", 2, 10), ("10–20 m", 10, 20), ("> 20 m", 20, 999)):
        sel = ok & (depth >= lo) & (depth < hi)
        if sel.any():
            zones.append({"zone": name, "mean_rugosity": round(float(rug[sel].mean()), 3),
                          "mean_slope_deg": round(float(np.nanmean(slope[sel])), 1)})
    return {
        "overlays": [W.overlay("rugosity", rug_rgba, "Rugosity"), W.overlay("slope", slope_rgba, "Slope")],
        "legends": {"rugosity": rug_legend, "slope": slope_legend},
        "legend": rug_legend,
        "stats": {"mean_rugosity": round(float(rug[ok].mean()), 3),
                  "pct_complex": round(float((rug[ok] > 1.2).mean() * 100), 1),
                  "mean_slope_deg": round(float(np.nanmean(slope[valid])), 1), "by_zone": zones},
    }


def canopy(g: Grid, W: Writer, dsm, ground_filled, land):
    chm = dsm - ground_filled
    ok = land & ~np.isnan(chm)
    chm = np.where(ok, np.clip(chm, 0, 50), np.nan).astype(np.float32)
    canopy_mask = ok & (chm >= 2)
    rgba, legend = ramp(chm, 0, 25, "Greens", canopy_mask)
    legend["label"] = "Canopy height (m)"
    # Tree tops: peaks of the smoothed canopy at least 3 m tall and 3 m apart;
    # crowns grow from them over the canopy by watershed.
    rows, cols = np.nonzero(land)
    r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    sub = np.nan_to_num(chm[r0:r1, c0:c1], nan=0.0)
    smooth = ndimage.gaussian_filter(sub, 1.0)
    peaks = feature.peak_local_max(smooth, min_distance=3, threshold_abs=3.0, exclude_border=False)
    markers = np.zeros(sub.shape, np.int32)
    markers[peaks[:, 0], peaks[:, 1]] = np.arange(1, len(peaks) + 1)
    crowns = segmentation.watershed(-smooth, markers, mask=sub >= 2)
    areas = np.bincount(crowns.ravel(), minlength=len(peaks) + 1)[1:] * g.res * g.res
    xs, ys = g.xy(peaks[:, 0] + r0, peaks[:, 1] + c0)
    heights = sub[peaks[:, 0], peaks[:, 1]]
    trees = [(Point(x, y), {"h": round(float(h), 1), "crown_m2": int(a)})
             for x, y, h, a in zip(xs, ys, heights, areas)]
    hist_edges = list(range(2, 32, 2))
    hist, _ = np.histogram(heights, bins=hist_edges + [100])
    log(f"       {len(trees):,} trees")
    return {
        "overlays": [W.overlay("canopy", rgba, "Canopy height")],
        "vectors": [W.geojson("trees", trees, "Tree tops", {"point": "#14532d", "size": 3})],
        "legend": legend,
        "stats": {"trees": len(trees), "canopy_cover_pct": round(float(canopy_mask.sum() / land.sum() * 100), 1),
                  "canopy_ha": ha(canopy_mask.sum()), "mean_tree_m": round(float(heights.mean()), 1),
                  "max_tree_m": round(float(heights.max()), 1),
                  "height_hist": [[e, int(c)] for e, c in zip(hist_edges, hist)]},
    }


def tsunami(g: Grid, W: Writer, ground, land, thresholds):
    """High ground for tsunami evacuation: land above each height, shown together."""
    edges = list(thresholds) + [1e9]
    labels = [f"{a}–{b} m" for a, b in zip(thresholds, thresholds[1:])] + [f"Above {thresholds[-1]} m"]
    colors = ["#86efac", "#22c55e", "#15803d"]
    safe = land & (ground >= thresholds[0])
    rgba, legend = bands(ground, edges, colors, safe, labels)
    rows = [{"height_m": t, "safe_ha": ha((land & (ground >= t)).sum()),
             "pct_land": round(float((land & (ground >= t)).sum() / land.sum() * 100), 1)} for t in thresholds]
    for r in rows:
        log(f"       above {r['height_m']} m: {r['safe_ha']} ha ({r['pct_land']}% of land)")
    return {
        "overlays": [W.overlay("tsunami_safe", rgba, "Safe areas")],
        "legend": legend,
        "stats": {"thresholds": rows},
    }


def drainage(g: Grid, W: Writer, ground_filled, land):
    # 2 m, land only: the sea is the outlet for everything.
    f = 2
    h, w = land.shape
    H, Wd = h // f, w // f
    dem = np.nanmean(ground_filled[:H * f, :Wd * f].reshape(H, f, Wd, f), axis=(1, 3))
    lnd = land[:H * f, :Wd * f].reshape(H, f, Wd, f).mean(axis=(1, 3)) > 0.5
    lnd &= ~np.isnan(dem)
    rows, cols = np.nonzero(lnd)
    r0, r1, c0, c1 = max(rows.min() - 1, 0), min(rows.max() + 2, H), max(cols.min() - 1, 0), min(cols.max() + 2, Wd)
    dem, lnd = dem[r0:r1, c0:c1].astype(np.float64), lnd[r0:r1, c0:c1]
    sh = dem.shape
    filled = np.where(lnd, np.inf, -np.inf)
    # Priority flood from every land cell that touches the sea, with a tiny
    # gradient across flats so every cell drains somewhere.
    edge = lnd & ndimage.binary_dilation(~lnd)
    heap = [(dem[r, c], r, c) for r, c in zip(*np.nonzero(edge))]
    heapq.heapify(heap)
    for z, r, c in heap:
        filled[r, c] = z
    eps = 1e-4
    nbrs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    done = ~lnd | edge
    while heap:
        z, r, c = heapq.heappop(heap)
        for dr, dc in nbrs:
            rr, cc = r + dr, c + dc
            if 0 <= rr < sh[0] and 0 <= cc < sh[1] and not done[rr, cc]:
                done[rr, cc] = True
                nz = max(dem[rr, cc], z + eps)
                filled[rr, cc] = nz
                heapq.heappush(heap, (nz, rr, cc))
    depth = np.where(lnd, filled - dem, 0.0)
    pits = depth > 0.15
    labels, n = ndimage.label(pits)
    idx = np.arange(1, n + 1)
    vol = ndimage.sum(depth, labels, idx) * f * f
    maxd = ndimage.maximum(depth, labels, idx)
    keep = {int(i): (float(v), float(m)) for i, v, m in zip(idx, vol, maxd) if v >= 10}
    sub_grid = Grid(g.x0 + c0 * f * g.res, g.y1 - r0 * f * g.res, sh[1], sh[0], g.res * f, g.wkt)
    polys = []
    for lab, (v, m) in keep.items():
        for cnt in measure.find_contours(np.pad(labels == lab, 1).astype(np.float32), 0.5):
            if len(cnt) < 4:
                continue
            x, y = sub_grid.xy(cnt[:, 0] - 1, cnt[:, 1] - 1)
            poly = Polygon(np.column_stack([x, y])).buffer(0)
            if poly.area >= 8:
                polys.append((poly.simplify(1.0), {"volume_m3": round(v), "max_depth_m": round(m, 2)}))
    # D8 flow on the filled surface, accumulated from the top down.
    fz = np.where(lnd, filled, -1e9)
    best = np.zeros(sh, np.float64)
    recv = np.full(sh, -1, np.int64)
    flat_idx = np.arange(fz.size).reshape(sh)
    for dr, dc in nbrs:
        shifted = np.full(sh, np.inf)
        ys = slice(max(dr, 0), sh[0] + min(dr, 0))
        yd = slice(max(-dr, 0), sh[0] + min(-dr, 0))
        xs_ = slice(max(dc, 0), sh[1] + min(dc, 0))
        xd = slice(max(-dc, 0), sh[1] + min(-dc, 0))
        shifted[yd, xd] = fz[ys, xs_]
        nidx = np.full(sh, -1, np.int64)
        nidx[yd, xd] = flat_idx[ys, xs_]
        drop = (fz - shifted) / math.hypot(dr, dc)
        better = drop > best
        best = np.where(better, drop, best)
        recv = np.where(better, nidx, recv)
    acc = np.where(lnd, 1.0, 0.0).ravel()
    order = np.argsort(-fz, axis=None)
    rv = recv.ravel()
    accl = acc.tolist()
    for i in order.tolist():
        j = rv[i]
        if j >= 0:
            accl[j] += accl[i]
    area = np.array(accl).reshape(sh) * (f * g.res) ** 2
    streams = lnd & (area >= 5000)
    rgba = np.zeros(sh + (4,), np.uint8)
    strength = np.clip((np.log10(np.maximum(area, 1)) - 3.7) / 2.0, 0, 1)
    rgba[streams, 0] = (30 + 0 * strength[streams]).astype(np.uint8)
    rgba[streams, 1] = (110 - 60 * strength[streams]).astype(np.uint8)
    rgba[streams, 2] = (230 - 80 * strength[streams]).astype(np.uint8)
    rgba[streams, 3] = 235
    # Thicken the 2 m lines a touch for visibility at survey scale.
    thick = ndimage.binary_dilation(streams)
    rgba[thick & ~streams] = rgba[streams].mean(axis=0).astype(np.uint8) if streams.any() else 0
    full = np.zeros(land.shape + (4,), np.uint8)
    up = np.kron(rgba, np.ones((f, f, 1), np.uint8))
    full[r0 * f:r0 * f + up.shape[0], c0 * f:c0 * f + up.shape[1]] = up
    log(f"       {len(polys)} depressions, {int(streams.sum()):,} stream cells")
    return {
        "overlays": [W.overlay("flow", full, "Flow paths")],
        "vectors": [W.geojson("depressions", polys, "Low-lying spots", {"fill": "#0ea5e9", "stroke": "#0369a1", "width": 1})],
        "legend": {"type": "classes", "items": [["Flow path", "#1e6ee6"], ["Low-lying spot", "#0ea5e9"]]},
        "stats": {"depressions": len(polys), "total_volume_m3": round(sum(v for v, _ in keep.values())),
                  "largest_m3": round(max((v for v, _ in keep.values()), default=0)),
                  "deepest_m": round(max((m for _, m in keep.values()), default=0), 2)},
    }


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=ROOT / "public/tonga/topobathy.copc.laz")
    ap.add_argument("--out", type=Path, default=ROOT / "public/tonga/products")
    ap.add_argument("--work", type=Path, default=ROOT / ".products-build")
    ap.add_argument("--regrid", action="store_true", help="rebuild the 1 m grids from the COPC")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    args.work.mkdir(parents=True, exist_ok=True)

    t0 = time.time()
    log("[1/3] water level and grids")
    wl = water_level(args.src)
    if wl is None:
        raise SystemExit("no water-surface returns (classes 9/41) to take the water level from")
    log(f"       water level {wl:.2f} m above the ellipsoid")
    g = make_grid(args.src, RES)
    grid = lambda cls, stat, name: grid_classes(args.src, g, cls, stat, args.work, name, args.workers, args.regrid)
    ground = fill_holes(grid([2], "mean", "ground"), g, 3) - wl
    seabed = fill_holes(grid([40], "mean", "seabed"), g, 3) - wl
    dsm = grid([2, 3, 4, 5, 6], "max", "surface") - wl

    land = ~np.isnan(ground) & (ground > 0)
    land = morphology.remove_small_objects(land, 200)
    land = morphology.remove_small_holes(land, 200)
    # Filled holes carry no ground height; land is only where there is one.
    land &= ~np.isnan(ground)
    ground_filled = fill_holes(ground, g, 25)  # under canopy, for CHM and drainage

    W = Writer(g, args.out)
    products = {}
    steps = [
        ("elevation", lambda: hypsometry(g, W, ground, land)),
        ("bathymetry", lambda: bathymetry(g, W, seabed)),
        ("reef-rugosity", lambda: rugosity(g, W, seabed)),
        ("canopy-height", lambda: canopy(g, W, dsm, ground_filled, land)),
        ("tsunami-safe-zones", lambda: tsunami(g, W, ground, land, [5, 10, 15])),
        ("drainage", lambda: drainage(g, W, ground_filled, land)),
    ]
    log("[2/3] products")
    for slug, fn in steps:
        t = time.time()
        log(f"     {slug}")
        products[slug] = fn()
        log(f"       done ({time.time() - t:.0f}s)")

    to_ll = W.to_ll
    y0 = g.y1 - g.height * g.res
    w_, s_ = to_ll(g.x0, y0)
    e_, n_ = to_ll(g.x0 + g.width * g.res, g.y1)
    manifest = {
        "survey": "Mango Island, Tonga (topo-bathy LiDAR)",
        "waterLevel": round(wl, 2),
        "heights": "metres relative to the water level measured in the survey (0 = sea surface at survey time)",
        "resolution_m": RES,
        "bounds": [round(w_, 6), round(s_, 6), round(e_, 6), round(n_, 6)],
        "products": products,
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    size = sum(p.stat().st_size for p in args.out.iterdir()) / 1e6
    log(f"[3/3] {len(products)} products, {size:.0f} MB -> {args.out} ({time.time() - t0:.0f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
