#!/usr/bin/env python
"""
Build Cesium quantized-mesh terrain straight from the COPC point cloud.

    topobathy.copc.laz --PDAL--> DEM (UTM, binned mean of ground + bathy bottom)
                       --> public/tonga/terrain.pmtiles (quantized-mesh tiles, gzipped)

One archive, read with HTTP range requests. layer.json (which tiles exist) and the
viewer's terrain metadata travel inside it. `--format dir` writes the classic
{z}/{x}/{y}.terrain tree plus layer.json instead, for any Cesium terrain server.

Heights are the file's own Z values, untouched: no scaling, no offset, no
vertical exaggeration. Cesium reads them as heights above the WGS84 ellipsoid,
which is exactly how the point cloud itself is drawn, so the two line up.

Run in the `pcl` environment (PDAL, GDAL, numpy, pymartini, pmtiles):

    micromamba run -n pcl python scripts/build_cesium_terrain.py

Stages can be rerun on their own: `--stage grid` builds the DEM, `--stage tiles`
meshes an existing one.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import numpy as np
import pdal
from osgeo import gdal, osr
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from pymartini import Martini
from scipy import ndimage

gdal.UseExceptions()

ROOT = Path(__file__).resolve().parent.parent
NODATA = -9999.0

# Terrain tiles are 65 x 65 posts: a 64-cell grid whose edge posts are shared
# with the neighbouring tile.
GRID = 64
POSTS = GRID + 1
QMAX = 32767

# WGS84
A = 6378137.0
B = 6356752.3142451793
E2 = 1.0 - (B * B) / (A * A)
MEAN_R = 6371008.8


# --------------------------------------------------------------------------
# Stage 1: DEM
# --------------------------------------------------------------------------

def grid_block(args: tuple) -> str:
    """Bin one block of points into cells. Returns the block's GeoTIFF path."""
    src, out, x0, y0, width, height, res, classes = args
    expr = " || ".join(f"Classification == {c}" for c in classes)
    x1, y1 = x0 + width * res, y0 + height * res
    pipeline = [
        {"type": "readers.copc", "filename": str(src),
         # COPC answers a spatial query by reading only the octree nodes it needs.
         "bounds": f"([{x0},{x1}],[{y0},{y1}])", "threads": 2},
        {"type": "filters.expression", "expression": expr},
        {"type": "writers.gdal", "filename": str(out),
         "resolution": res, "output_type": "mean",
         # Each point counts only toward the cell it falls in. Without this,
         # writers.gdal averages everything within res*sqrt(2) of a cell centre,
         # which smooths the surface across neighbouring cells.
         "binmode": True, "window_size": 0,
         "origin_x": x0, "origin_y": y0, "width": width, "height": height,
         "data_type": "float32", "nodata": NODATA, "gdaldriver": "GTiff",
         "gdalopts": "COMPRESS=DEFLATE,PREDICTOR=3,TILED=YES"},
    ]
    pdal.Pipeline(json.dumps(pipeline)).execute()
    return str(out)


def build_dem(src: Path, work: Path, res: float, classes: list[int], block_m: float,
              fill_px: int, workers: int) -> Path:
    info = json.loads(subprocess.run(
        ["pdal", "info", "--metadata", str(src)], check=True, capture_output=True, text=True,
    ).stdout)["metadata"]
    minx, maxx, miny, maxy = info["minx"], info["maxx"], info["miny"], info["maxy"]
    srs_wkt = info["srs"]["wkt"] if isinstance(info.get("srs"), dict) else info["comp_spatialreference"]

    # One global grid, snapped to the resolution, so blocks tile it exactly.
    gx0 = math.floor(minx / res) * res
    gy0 = math.floor(miny / res) * res
    gw = math.ceil((maxx - gx0) / res) + 1
    gh = math.ceil((maxy - gy0) / res) + 1
    step = int(block_m / res)

    blocks_dir = work / "blocks"
    shutil.rmtree(blocks_dir, ignore_errors=True)
    blocks_dir.mkdir(parents=True)
    jobs = []
    for by in range(0, gh, step):
        for bx in range(0, gw, step):
            w, h = min(step, gw - bx), min(step, gh - by)
            jobs.append((src, blocks_dir / f"b_{bx}_{by}.tif",
                         gx0 + bx * res, gy0 + by * res, w, h, res, classes))

    print(f"[1/4] gridding {info['count']:,} points at {res} m, classes {classes}: "
          f"{gw} x {gh} cells in {len(jobs)} blocks", flush=True)
    t = time.time()
    with ProcessPoolExecutor(workers) as pool:
        for i, f in enumerate(as_completed([pool.submit(grid_block, j) for j in jobs]), 1):
            f.result()
            print(f"       block {i}/{len(jobs)}  ({time.time() - t:.0f}s)", flush=True)

    # writers.gdal leaves the CRS off a block that received no points, and
    # gdalbuildvrt then drops every block whose CRS differs from the first one's.
    blocks = sorted(str(p) for p in blocks_dir.glob("*.tif"))
    for path in blocks:
        ds = gdal.Open(path, gdal.GA_Update)
        ds.SetProjection(srs_wkt)
        ds = None

    vrt = work / "dem.vrt"
    dem = work / "dem.tif"
    gdal.BuildVRT(str(vrt), blocks)
    gdal.Translate(str(dem), str(vrt), outputSRS=srs_wkt, noData=NODATA,
                   creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES", "BIGTIFF=IF_SAFER"])
    shutil.rmtree(blocks_dir)
    vrt.unlink()

    # Pinholes between returns only: a cell with no point, surrounded by cells
    # that have them. Anything bigger stays empty rather than being invented.
    print(f"[2/4] filling holes up to {fill_px} cells ({fill_px * res:g} m) wide", flush=True)
    ds = gdal.Open(str(dem), gdal.GA_Update)
    band = ds.GetRasterBand(1)
    gdal.FillNodata(band, None, maxSearchDist=fill_px, smoothingIterations=0)
    band.ComputeStatistics(False)
    # Averaged overviews, so coarse zoom levels read a properly downsampled
    # surface instead of point-sampling the 0.5 m grid.
    ds.BuildOverviews("AVERAGE", [2, 4, 8, 16, 32, 64, 128])
    ds = None
    return dem


# --------------------------------------------------------------------------
# Stage 2: quantized-mesh tiles
# --------------------------------------------------------------------------

def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """Cesium's geographic scheme: 2 x 1 root tiles, TMS rows counted up from -90."""
    span = 180.0 / 2 ** z
    w, s = -180.0 + x * span, -90.0 + y * span
    return w, s, w + span, s + span


def tile_range(bounds, z: int) -> tuple[int, int, int, int]:
    n = 2 ** z
    span = 180.0 / n
    w, s, e, nth = bounds
    return (max(0, int((w + 180.0) // span)), max(0, int((s + 90.0) // span)),
            min(2 * n - 1, int((e + 180.0) // span)), min(n - 1, int((nth + 90.0) // span)))


def ecef(lon: np.ndarray, lat: np.ndarray, h: np.ndarray) -> np.ndarray:
    lo, la = np.radians(lon), np.radians(lat)
    n = A / np.sqrt(1.0 - E2 * np.sin(la) ** 2)
    return np.stack([(n + h) * np.cos(la) * np.cos(lo),
                     (n + h) * np.cos(la) * np.sin(lo),
                     (n * (1.0 - E2) + h) * np.sin(la)], axis=-1)


def horizon_occlusion_point(points: np.ndarray, center: np.ndarray, min_h: float) -> np.ndarray:
    """
    Cesium's EllipsoidalOccluder.computeHorizonCullingPoint, in ellipsoid-scaled
    space. If the tile dips below the ellipsoid the ellipsoid is shrunk by that
    much, matching how Cesium tests it (isScaledSpacePointVisiblePossiblyUnderEllipsoid).
    """
    radii = np.array([A, A, B]) + min(0.0, min_h)
    scaled = points / radii
    d = center / radii
    d /= np.linalg.norm(d)
    mag2 = np.sum(scaled * scaled, axis=1)
    direction = scaled / np.sqrt(mag2)[:, None]
    mag2 = np.maximum(1.0, mag2)
    mag = np.sqrt(mag2)
    cos_a = direction @ d
    sin_a = np.linalg.norm(np.cross(direction, d), axis=1)
    cos_b = 1.0 / mag
    sin_b = np.sqrt(mag2 - 1.0) * cos_b
    denom = cos_a * cos_b - sin_a * sin_b
    if np.any(denom <= 0):
        # The tile wraps too far round the globe for any single point to stand
        # in for it (only the hemisphere-sized root levels). A point far out along
        # its centre direction is visible from anywhere the tile could be.
        return d * 1e3
    return d * np.max(1.0 / denom)


def zigzag_delta(values: np.ndarray) -> np.ndarray:
    d = np.diff(values.astype(np.int32), prepend=0)
    return np.where(d >= 0, 2 * d, -2 * d - 1).astype(np.uint16)


def encode_tile(grid: np.ndarray, bounds, max_error: float) -> bytes:
    """One quantized-mesh-1.0 tile from a 65 x 65 height grid (row 0 = north)."""
    w, s, e, n = bounds

    # Simplify on height plus the Earth's curvature. A triangle is drawn as a flat
    # chord in 3D, and linear interpolation of this paraboloid over any triangle is
    # off by exactly that chord's sagitta (L^2 / 8R), so the error bound covers
    # both relief and curvature. On height alone, a flat tile collapses to two
    # triangles however large it is, and a coarse tile cuts through the planet.
    lat_c = math.radians(max(-89.0, min(89.0, (s + n) / 2)))
    dx = math.radians(e - w) * MEAN_R * max(math.cos(lat_c), 0.05) / GRID
    dy = math.radians(n - s) * MEAN_R / GRID
    ii = np.arange(POSTS) - GRID / 2
    bulge = -((ii[None, :] * dx) ** 2 + (ii[:, None] * dy) ** 2) / (2 * MEAN_R)
    tin = Martini(POSTS).create_tile(np.ascontiguousarray(grid + bulge, dtype=np.float32))
    vertices, triangles = tin.get_mesh(max_error)
    vertices = vertices.reshape(-1, 2).astype(np.int64)  # (col, row) in grid space
    triangles = triangles.reshape(-1, 3).astype(np.int64)

    # High-water-mark index coding needs vertices numbered in order of first use.
    order = np.unique(triangles.ravel(), return_index=True)
    first_use = order[0][np.argsort(order[1])]
    remap = np.empty(len(vertices), dtype=np.int64)
    remap[first_use] = np.arange(len(first_use))
    vertices = vertices[first_use]
    triangles = remap[triangles]

    col, row = vertices[:, 0], vertices[:, 1]
    heights = grid[row, col].astype(np.float64)
    u = np.round(col / GRID * QMAX).astype(np.int64)
    v = np.round((GRID - row) / GRID * QMAX).astype(np.int64)

    # Counter-clockwise seen from above, or Cesium's backface culling drops it.
    p0, p1, p2 = triangles[:, 0], triangles[:, 1], triangles[:, 2]
    cross = (u[p1] - u[p0]) * (v[p2] - v[p0]) - (v[p1] - v[p0]) * (u[p2] - u[p0])
    cw = cross < 0
    triangles[cw, 1], triangles[cw, 2] = p2[cw], p1[cw]

    min_h, max_h = float(heights.min()), float(heights.max())
    span_h = max_h - min_h
    hq = np.zeros_like(u) if span_h == 0 else np.round((heights - min_h) / span_h * QMAX).astype(np.int64)

    lon = w + u / QMAX * (e - w)
    lat = s + v / QMAX * (n - s)
    pts = ecef(lon, lat, min_h + hq / QMAX * span_h)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    center = (lo + hi) / 2
    radius = float(np.max(np.linalg.norm(pts - center, axis=1)))
    hop = horizon_occlusion_point(pts, center, min_h)

    out = bytearray()
    out += struct.pack("<3d2f4d3d", *center, min_h, max_h, *center, radius, *hop)
    out += struct.pack("<I", len(u))
    out += zigzag_delta(u).tobytes() + zigzag_delta(v).tobytes() + zigzag_delta(hq).tobytes()

    idx = triangles.ravel()
    codes = np.empty(len(idx), dtype=np.int64)
    highest = 0
    for k, i in enumerate(idx.tolist()):
        codes[k] = highest - i
        if i == highest:
            highest += 1
    out += struct.pack("<I", len(triangles)) + codes.astype(np.uint16).tobytes()

    # Edge vertices, for the skirts that hide cracks between tiles of different levels.
    for mask, key in ((u == 0, v), (v == 0, u), (u == QMAX, v), (v == QMAX, u)):
        edge = np.nonzero(mask)[0]
        edge = edge[np.argsort(key[edge])]
        out += struct.pack("<I", len(edge)) + edge.astype(np.uint16).tobytes()
    return bytes(out)


def pull_push(values: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """
    Fill gaps smoothly from their surroundings. Known cells are averaged into ever
    coarser levels (pull), then each level fills its gaps from the one above,
    blended by how much of each cell was known (push). Known cells come out
    unchanged, and a filled gap meets the data at its edge with no step.
    """
    levels = []
    val = np.where(valid, values, 0.0).astype(np.float64)
    w = valid.astype(np.float64)
    while True:
        levels.append((val, w))
        if min(val.shape) <= 2 or w.min() > 0:
            break
        h, wd = val.shape
        ph, pw = h + h % 2, wd + wd % 2
        vp = np.zeros((ph, pw)); wp = np.zeros((ph, pw))
        vp[:h, :wd] = val * w; wp[:h, :wd] = w
        sw = wp.reshape(ph // 2, 2, pw // 2, 2).sum(axis=(1, 3))
        sv = vp.reshape(ph // 2, 2, pw // 2, 2).sum(axis=(1, 3))
        val = np.where(sw > 0, sv / np.maximum(sw, 1e-12), 0.0)
        w = np.minimum(sw, 1.0)
    top_val, top_w = levels[-1]
    filled = np.where(top_w > 0, top_val, np.average(top_val, weights=top_w + 1e-12))
    for val, w in reversed(levels[:-1]):
        up = ndimage.zoom(filled, 2, order=1, grid_mode=True, mode="nearest")
        up = up[: val.shape[0], : val.shape[1]]
        filled = w * val + (1.0 - w) * up
    return filled


def build_fill_surface(dem: Path, work: Path, res: float, margin: float, taper: float,
                       far: float | None) -> tuple[Path, float]:
    """
    Heights for every cell the survey has no ground or seabed return for.

    Gaps inside the survey are interpolated from their edges. Outside it, the edge
    heights are carried outward and eased over `taper` metres to a single far-field
    height, so the survey never ends in a wall. None of this touches a cell that
    has data; the tiles take those from the DEM itself.
    """
    ds = gdal.Open(str(dem))
    gt, xs, ys = ds.GetGeoTransform(), ds.RasterXSize, ds.RasterYSize
    minx, maxy = gt[0], gt[3]
    maxx, miny = minx + xs * gt[1], maxy + ys * gt[5]
    out = work / "fill.tif"
    coarse = gdal.Warp("", ds, format="MEM", xRes=res, yRes=res,
                       outputBounds=(minx - margin, miny - margin, maxx + margin, maxy + margin),
                       resampleAlg="average", srcNodata=NODATA, dstNodata=NODATA)
    arr = coarse.GetRasterBand(1).ReadAsArray().astype(np.float64)
    valid = arr != NODATA

    # Gaps that reach the padded border are the outside world; the rest are holes.
    labels, _ = ndimage.label(~valid)
    border = np.unique(np.r_[labels[0], labels[-1], labels[:, 0], labels[:, -1]])
    outside = np.isin(labels, border[border > 0])
    rim = valid & ndimage.binary_dilation(outside)
    if far is None:
        # The survey's own edge heights, so the far field sits where the data stops.
        far = float(np.median(arr[rim]))

    surface = pull_push(arr, valid)
    dist = ndimage.distance_transform_edt(outside) * res
    t = np.clip(dist / taper, 0.0, 1.0)
    ease = t * t * (3.0 - 2.0 * t)
    surface = np.where(outside, (1.0 - ease) * surface + ease * far, surface)

    drv = gdal.GetDriverByName("GTiff")
    dst = drv.Create(str(out), arr.shape[1], arr.shape[0], 1, gdal.GDT_Float32,
                     ["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=YES"])
    dst.SetGeoTransform(coarse.GetGeoTransform())
    dst.SetProjection(coarse.GetProjection())
    dst.GetRasterBand(1).WriteArray(surface.astype(np.float32))
    dst = None
    return out, far


_DEM: gdal.Dataset | None = None
_FILL: gdal.Dataset | None = None


def _init_worker(dem: str, fill_surface: str) -> None:
    global _DEM, _FILL
    gdal.UseExceptions()
    _DEM = gdal.Open(dem)
    _FILL = gdal.Open(fill_surface)


def _sample(ds: gdal.Dataset, bounds, nodata: float | None) -> np.ndarray:
    w, s, e, n = bounds
    half = (e - w) / GRID / 2
    # Pixel centres on the posts: post 0 sits exactly on the west edge and post 64
    # on the east edge, so neighbouring tiles sample identical edge heights.
    opts = dict(format="MEM", dstSRS="EPSG:4326",
                outputBounds=(w - half, s - half, e + half, n + half),
                width=POSTS, height=POSTS, resampleAlg="bilinear", dstNodata=NODATA)
    if nodata is not None:
        opts["srcNodata"] = nodata
    out = gdal.Warp("", ds, **opts)
    grid = out.GetRasterBand(1).ReadAsArray().astype(np.float32)
    out = None
    return grid


def build_tile(job: tuple) -> tuple[int, int, int, bytes, int]:
    z, x, y, far, max_error = job
    w, s, e, n = tile_bounds(z, x, y)
    grid = _sample(_DEM, (w, s, e, n), NODATA)
    gap = grid == NODATA
    covered = int(np.count_nonzero(~gap))
    if gap.any():
        filler = _sample(_FILL, (w, s, e, n), None)
        filler[filler == NODATA] = far  # beyond the fill surface's own margin
        grid[gap] = filler[gap]
    return z, x, y, encode_tile(grid, (w, s, e, n), max_error), covered


# PMTiles numbers tiles on a square pyramid (2^z x 2^z), but Cesium's geographic
# scheme is 2^(z+1) x 2^z. Stored one zoom deeper, every geographic tile's x and y
# fit, and the viewer subtracts this again when it asks for a tile.
PMTILES_ZOOM_OFFSET = 1


def water_level(src: Path) -> float | None:
    """Median height of the water-surface returns (ASPRS 9 and 41), from a coarse read."""
    pipeline = [
        {"type": "readers.copc", "filename": str(src), "resolution": 5.0},
        {"type": "filters.expression", "expression": "Classification == 9 || Classification == 41"},
    ]
    try:
        p = pdal.Pipeline(json.dumps(pipeline))
        p.execute()
        z = np.concatenate([a["Z"] for a in p.arrays]) if p.arrays else np.empty(0)
        return float(np.median(z)) if z.size else None
    except Exception:  # noqa: BLE001 - informational only
        return None


def terrain_meta(dem: Path, src: Path, maxzoom: int, resolution: float) -> dict:
    """What the viewer shows and frames from: extent, resolution, height statistics."""
    ds = gdal.Open(str(dem))
    band = ds.GetRasterBand(1)
    arr = band.GetOverview(2).ReadAsArray()
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
        "waterLevel": water_level(src),
        "elevation": {"min": float(v.min()), "max": float(v.max()),
                      "mean": float(v.mean()), "median": float(np.median(v))},
        "bounds3857": [min(p[0] for p in pts), min(p[1] for p in pts),
                       max(p[0] for p in pts), max(p[1] for p in pts)],
    }


def build_tiles(dem: Path, out: Path, fmt: str, maxzoom: int, max_error: float,
                fill: float | None, workers: int, describe) -> dict:
    """
    Mesh every tile over the survey and write them to `out`: a single PMTiles
    archive (fmt="pmtiles") or a {z}/{x}/{y}.terrain tree with layer.json
    (fmt="dir"). `describe(result)` returns the metadata to store with them.
    """
    print("       building the gap-fill surface", flush=True)
    fill_surface, fill = build_fill_surface(dem, dem.parent, res=5.0, margin=6000.0,
                                            taper=3000.0, far=fill)
    ds = gdal.Open(str(dem))
    stats = ds.GetRasterBand(1).GetStatistics(False, True)

    # Survey extent in lon/lat, from the DEM's corners and edge midpoints.
    gt, xs, ys = ds.GetGeoTransform(), ds.RasterXSize, ds.RasterYSize
    src = osr.SpatialReference(wkt=ds.GetProjection())
    dst = osr.SpatialReference()
    dst.ImportFromEPSG(4326)
    for sr in (src, dst):
        sr.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(src, dst)
    edge = [(gt[0] + px * gt[1], gt[3] + py * gt[5])
            for px in (0, xs / 2, xs) for py in (0, ys / 2, ys)]
    ll = [tr.TransformPoint(px, py)[:2] for px, py in edge]
    bounds = (min(p[0] for p in ll), min(p[1] for p in ll),
              max(p[0] for p in ll), max(p[1] for p in ll))
    ds = None

    jobs, available = [], []
    for z in range(maxzoom + 1):
        x0, y0, x1, y1 = tile_range(bounds, z)
        available.append([{"startX": x0, "startY": y0, "endX": x1, "endY": y1}])
        jobs += [(z, x, y, fill, max_error) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    # Hilbert order, so the archive is clustered: neighbouring tiles sit in
    # neighbouring bytes. map() below keeps this order.
    jobs.sort(key=lambda j: zxy_to_tileid(j[0] + PMTILES_ZOOM_OFFSET, j[1], j[2]))

    layer = {
        "tilejson": "2.1.0",
        "name": "copc-terrain",
        "description": "Quantized-mesh terrain from the LiDAR survey",
        "version": "1.0.0",
        "format": "quantized-mesh-1.0",
        "attribution": "",
        "schema": "tms",
        "extensions": [],
        "tiles": ["{z}/{x}/{y}.terrain"],
        "projection": "EPSG:4326",
        "bounds": [-180, -90, 180, 90],
        "available": available,
    }

    post_m = math.radians(180.0 / 2 ** maxzoom / GRID) * MEAN_R
    print(f"[3/4] meshing {len(jobs):,} tiles z0-{maxzoom} (posts {post_m:.2f} m apart "
          f"at z{maxzoom}, error {max_error} m; gaps interpolated, far field {fill:.2f} m) "
          f"-> {fmt}", flush=True)

    staging = out.with_name(out.name + ".partial")
    if staging.is_dir():
        shutil.rmtree(staging)
    staging.unlink(missing_ok=True)
    t, raw, stored, done = time.time(), 0, 0, 0
    writer, fh = None, None
    if fmt == "pmtiles":
        fh = open(staging, "wb")
        writer = Writer(fh)
    else:
        staging.mkdir(parents=True)

    with ProcessPoolExecutor(workers, initializer=_init_worker,
                             initargs=(str(dem), str(fill_surface))) as pool:
        for z, x, y, data, _ in pool.map(build_tile, jobs, chunksize=64):
            raw += len(data)
            if writer:
                # Quantized mesh gzips well; the viewer's PMTiles reader inflates it.
                data = gzip.compress(data, compresslevel=6, mtime=0)
                writer.write_tile(zxy_to_tileid(z + PMTILES_ZOOM_OFFSET, x, y), data)
            else:
                path = staging / str(z) / str(x) / f"{y}.terrain"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            stored += len(data)
            done += 1
            if done % 5000 == 0 or done == len(jobs):
                print(f"       {done:,}/{len(jobs):,} tiles, {stored / 1e6:.0f} MB "
                      f"({time.time() - t:.0f}s)", flush=True)

    result = {"tiles": len(jobs), "bytes": stored, "raw_bytes": raw, "far_field_m": fill,
              "bounds": bounds, "dem_min": stats[0], "dem_max": stats[1],
              "post_spacing_m": post_m}
    info = describe(result)

    if writer:
        e7 = lambda v: int(round(v * 1e7))
        writer.finalize(
            {
                "tile_type": TileType.UNKNOWN,  # quantized-mesh has no PMTiles type
                "tile_compression": Compression.GZIP,
                "min_lon_e7": e7(bounds[0]), "min_lat_e7": e7(bounds[1]),
                "max_lon_e7": e7(bounds[2]), "max_lat_e7": e7(bounds[3]),
                "center_zoom": 13 + PMTILES_ZOOM_OFFSET,
                "center_lon_e7": e7((bounds[0] + bounds[2]) / 2),
                "center_lat_e7": e7((bounds[1] + bounds[3]) / 2),
            },
            {
                "name": "Tonga terrain",
                "format": "quantized-mesh-1.0",
                # How to read it back: geographic TMS tiles, stored one zoom deeper.
                "scheme": "cesium-geographic-tms",
                "zoomOffset": PMTILES_ZOOM_OFFSET,
                "layer": layer,
                "terrainMeta": info.pop("terrainMeta"),
                "build": info,
            },
        )
        fh.close()
        out.unlink(missing_ok=True)
    else:
        (staging / "layer.json").write_text(json.dumps(layer, indent=2))
        (staging / "meta.json").write_text(json.dumps(info.pop("terrainMeta"), indent=2))
        (staging / "build-info.json").write_text(json.dumps(info, indent=2))
        shutil.rmtree(out, ignore_errors=True)
    # Swap in only once every tile is written.
    staging.rename(out)
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=ROOT / "public/tonga/topobathy.copc.laz")
    ap.add_argument("--format", choices=["pmtiles", "dir"], default="pmtiles",
                    help="one PMTiles archive (default) or a {z}/{x}/{y}.terrain directory")
    ap.add_argument("--out", type=Path, default=None,
                    help="default: public/tonga/terrain.pmtiles, or public/tonga/cesium-terrain "
                         "with --format dir")
    ap.add_argument("--work", type=Path, default=ROOT / ".terrain-build")
    ap.add_argument("--stage", choices=["all", "grid", "tiles"], default="all")
    ap.add_argument("--resolution", type=float, default=0.5, help="DEM cell size in metres")
    ap.add_argument("--classes", type=int, nargs="+", default=[2, 40],
                    help="ASPRS classes that make up the surface: ground, bathymetric bottom")
    ap.add_argument("--fill-px", type=int, default=4,
                    help="largest hole, in cells, filled from its neighbours")
    ap.add_argument("--block", type=float, default=2000, help="gridding block size in metres")
    ap.add_argument("--maxzoom", type=int, default=19,
                    help="z19 puts terrain posts about 0.6 m apart, matching the 0.5 m DEM")
    ap.add_argument("--error", type=float, default=0.025,
                    help="mesh simplification tolerance in metres (height + curvature). "
                         "Martini estimates error at hypotenuse midpoints only; measured "
                         "worst case over every post is about 1.7x this, so 0.025 keeps "
                         "the surface within ~4 cm of the DEM")
    ap.add_argument("--fill", type=float, default=None,
                    help="far-field height well outside the survey (default: median "
                         "height along the survey's edge); gaps are interpolated")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    args = ap.parse_args()
    out = args.out or ROOT / ("public/tonga/terrain.pmtiles" if args.format == "pmtiles"
                              else "public/tonga/cesium-terrain")

    args.work.mkdir(parents=True, exist_ok=True)
    dem = args.work / "dem.tif"
    if args.stage in ("all", "grid"):
        dem = build_dem(args.src, args.work, args.resolution, args.classes, args.block,
                        args.fill_px, args.workers)
    if args.stage in ("all", "tiles"):
        if not dem.exists():
            print(f"error: {dem} not found; run --stage grid first", file=sys.stderr)
            return 1

        def describe(result: dict) -> dict:
            return {
                "built": date.today().isoformat(),
                "source": args.src.name,
                "classes": args.classes,
                "dem_resolution_m": args.resolution,
                "dem_method": "binned mean per cell (PDAL writers.gdal binmode)",
                "holes_filled_up_to_m": args.fill_px * args.resolution,
                "gaps": "cells with no ground/bathy return: interpolated from surrounding data "
                        "(pull-push, 5 m); outside the survey, eased over 3 km to the far-field "
                        "height. Surveyed cells are never altered.",
                "heights": "file Z as stored, read as metres above the WGS84 ellipsoid; "
                           "no scaling, offset or exaggeration",
                "maxzoom": args.maxzoom,
                "mesh_error_m": args.error,
                "terrainMeta": terrain_meta(dem, args.src, args.maxzoom, args.resolution),
                **result,
            }

        result = build_tiles(dem, out, args.format, args.maxzoom, args.error, args.fill,
                             args.workers, describe)
        print(f"[4/4] {result['tiles']:,} tiles, {result['bytes'] / 1e6:.0f} MB -> {out}",
              flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
