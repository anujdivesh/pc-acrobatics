#!/usr/bin/env python
"""
Turn the orthophoto into a single PMTiles archive to drape on the Cesium globe.

    SRC.ecw --QGIS GDAL--> RGBA VRT --gdal2tiles--> XYZ PNG tiles (temporary)
            --> WebP --> public/tonga/ortho.pmtiles

One file instead of ~13,500, served with HTTP range requests like the COPC. The
viewer reads its zoom range, tile size, extent and resolution from the archive's
own header and metadata, so there is no meta.json to keep in step.

Run in the `pcl` environment (Pillow, pmtiles). The first two stages call QGIS's
GDAL, because the ECW driver is licensed and absent from conda-forge:

    micromamba run -n pcl python scripts/build_ortho_pmtiles.py

Already have gdal2tiles output (a z/x/y tile directory)? Pack it directly:

    micromamba run -n pcl python scripts/build_ortho_pmtiles.py --from-xyz path/to/tiles
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SRC = ROOT.parent / "03_Imagery/03_Imagery/01_Orthophoto/Mango_Island2026-RGB-010_7337747_01_0009_0006.ecw"
MERCATOR_HALF = 20037508.342789244

QGIS = Path("/Applications/QGIS.app/Contents")
QGIS_BIN = QGIS / "MacOS/bin"


def qgis_env() -> dict[str, str]:
    env = dict(os.environ)
    # The ECW driver lives outside GDAL's default plugin search path.
    env["GDAL_DRIVER_PATH"] = str(QGIS / "MacOS/lib/gdalplugins")
    # Without the PROJ database GDAL cannot build any coordinate transform, and
    # gdal2tiles does not stop or warn: it treats UTM metres as Web Mercator ones
    # and tiles the survey into the North Sea. This is what makes it reproject.
    env["PROJ_LIB"] = env["PROJ_DATA"] = str(QGIS / "Resources/proj")
    return env


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    shown = ["<script>" if i and cmd[i - 1] == "-c" else str(c) for i, c in enumerate(cmd)]
    print("  $", " ".join(shown), flush=True)
    return subprocess.run([str(c) for c in cmd], check=True, env=qgis_env(), **kw)


# --------------------------------------------------------------------------
# Stages 1-2: source -> XYZ PNG tiles (QGIS GDAL)
# --------------------------------------------------------------------------

BAND4_CHECK = r"""
import sys, numpy as np
from osgeo import gdal
ds = gdal.Open(sys.argv[1])
w = 1000; h = max(1, int(1000 * ds.RasterYSize / ds.RasterXSize))
r, g, b, b4 = [ds.GetRasterBand(i).ReadAsArray(buf_xsize=w, buf_ysize=h).astype(int) for i in (1, 2, 3, 4)]
blank = (r == 255) & (g == 255) & (b == 255)
zero_outside = (b4[blank] == 0).mean() if blank.any() else 1.0
bimodal = ((b4 < 16) | (b4 > 240)).mean()
print(f"{bimodal:.4f} {zero_outside:.4f}")
"""


def tile_source(src: Path, work: Path, minzoom: int, maxzoom: int, workers: int) -> tuple[Path, float]:
    info = json.loads(run([QGIS_BIN / "gdalinfo", "-json", src], capture_output=True, text=True).stdout)
    bands = len(info["bands"])
    pixel = abs(info["geoTransform"][1])
    print(f"[1/3] {bands}-band source, {pixel:g} m pixels", flush=True)

    ci = ["-colorinterp_1", "red", "-colorinterp_2", "green", "-colorinterp_3", "blue"]
    if bands >= 4:
        # Band 4 is usually alpha but can be near-infrared, and the header cannot
        # tell them apart (both report ColorInterp=Undefined). A mask is bimodal
        # (0 or 255) and zero wherever the image is blank; a measured band is not.
        out = run([QGIS_BIN / "python3", "-c", BAND4_CHECK, src], capture_output=True, text=True).stdout
        bimodal, zero_outside = (float(v) for v in out.split())
        print(f"      band 4: {bimodal:.0%} at the extremes, {zero_outside:.0%} zero over blank area",
              flush=True)
        if zero_outside > 0.95 and bimodal > 0.90:
            # This ECW's nodata half is stored as opaque white with the real mask in
            # band 4, unlabelled; labelling it is what makes it transparent.
            ci += ["-colorinterp_4", "alpha"]
        else:
            print("      band 4 does not behave like a mask (NIR?); tiling RGB only", flush=True)
            ci = ["-b", "1", "-b", "2", "-b", "3"] + ci

    # A plain pass-through VRT: no resampling here, so the ECW's own overviews
    # still serve the coarse zooms. Reprojecting in the VRT hides them and tiling
    # slows ~40x; gdal2tiles reprojects per tile instead.
    work.mkdir(parents=True, exist_ok=True)
    vrt = work / f"{src.stem}_rgba.vrt"
    run([QGIS_BIN / "gdal_translate", "-q", "-of", "VRT", *ci, src, vrt])

    xyz = work / "xyz"
    shutil.rmtree(xyz, ignore_errors=True)
    print(f"[2/3] tiling z{minzoom}-{maxzoom} (512 px PNG)", flush=True)
    # As a module, not the script: run as a script its __main__ has no __spec__,
    # which --processes needs. -n skips the KML sidecars.
    run([QGIS_BIN / "python3", "-m", "osgeo_utils.gdal2tiles", "--xyz", "--tilesize", "512",
         "-z", f"{minzoom}-{maxzoom}", "-r", "average", "-w", "none", "-n",
         "--processes", str(workers), vrt, xyz])
    return xyz, pixel


# --------------------------------------------------------------------------
# Stage 3: XYZ -> PMTiles
# --------------------------------------------------------------------------

def encode(job: tuple) -> tuple[int, bytes | None, int]:
    """PNG -> WebP. Returns None for a tile with nothing visible in it."""
    tileid, path, quality, lossless = job
    with Image.open(path) as im:
        im.load()
        has_alpha = im.mode in ("RGBA", "LA") or "transparency" in im.info
        im = im.convert("RGBA" if has_alpha else "RGB")
        if has_alpha:
            lo, hi = im.getchannel("A").getextrema()
            if hi == 0:
                return tileid, None, 0
            if lo == 255:
                im = im.convert("RGB")  # fully opaque: no alpha plane to store
        buf = io.BytesIO()
        # Alpha is always stored losslessly by WebP, so the survey edge stays crisp
        # even at lossy colour quality.
        # method 4: measured 40x faster than 6 on these tiles for 3% more bytes.
        im.save(buf, "WEBP", quality=quality, lossless=lossless, method=4, exact=False)
    return tileid, buf.getvalue(), path.stat().st_size


def pack(xyz: Path, out: Path, quality: int, lossless: bool, source_pixel: float | None,
         workers: int) -> dict:
    tiles = []
    for zdir in xyz.iterdir():
        if not zdir.name.isdigit():
            continue
        z = int(zdir.name)
        for xdir in zdir.iterdir():
            if not xdir.name.isdigit():
                continue
            for f in xdir.iterdir():
                if f.stem.isdigit() and f.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg"):
                    tiles.append((zxy_to_tileid(z, int(xdir.name), int(f.stem)), f))
    if not tiles:
        raise SystemExit(f"error: no z/x/y tiles under {xyz}")
    # Written in tile-id (Hilbert) order, the archive is "clustered": a client
    # reading a neighbourhood touches contiguous bytes.
    tiles.sort()

    zooms = sorted({int(p.parent.parent.name) for _, p in tiles})
    minzoom, maxzoom = zooms[0], zooms[-1]
    deep = [(int(p.parent.name), int(p.stem)) for _, p in tiles if int(p.parent.parent.name) == maxzoom]
    span = 2 * MERCATOR_HALF / 2 ** maxzoom
    xs = [x for x, _ in deep]; ys = [y for _, y in deep]
    b3857 = [min(xs) * span - MERCATOR_HALF, MERCATOR_HALF - (max(ys) + 1) * span,
             (max(xs) + 1) * span - MERCATOR_HALF, MERCATOR_HALF - min(ys) * span]

    def to_lonlat(mx: float, my: float) -> tuple[float, float]:
        return (math.degrees(mx / 6378137.0),
                math.degrees(math.atan(math.sinh(my / 6378137.0))))

    west, south = to_lonlat(b3857[0], b3857[1])
    east, north = to_lonlat(b3857[2], b3857[3])
    with Image.open(tiles[0][1]) as im:
        tile_size = im.width
    # Ground metres per pixel at the deepest zoom, at the survey's latitude.
    ground = span / tile_size * math.cos(math.radians((north + south) / 2))

    staging = out.with_suffix(".pmtiles.partial")
    print(f"[3/3] packing {len(tiles):,} tiles z{minzoom}-{maxzoom} -> WebP "
          f"({'lossless' if lossless else f'quality {quality}'})", flush=True)
    t, done, written, empty, src_bytes, out_bytes = time.time(), 0, 0, 0, 0, 0
    with open(staging, "wb") as f, ProcessPoolExecutor(workers) as pool:
        writer = Writer(f)
        jobs = ((tid, p, quality, lossless) for tid, p in tiles)
        # map() keeps input order, so tiles reach the writer still sorted.
        for tid, data, size in pool.map(encode, jobs, chunksize=32):
            done += 1
            src_bytes += size
            if data is None:
                empty += 1
            else:
                writer.write_tile(tid, data)
                written += 1
                out_bytes += len(data)
            if done % 2000 == 0 or done == len(tiles):
                print(f"       {done:,}/{len(tiles):,}  {src_bytes / 1e6:.0f} MB -> "
                      f"{out_bytes / 1e6:.0f} MB ({time.time() - t:.0f}s)", flush=True)

        e7 = lambda v: int(round(v * 1e7))
        header = {
            "tile_type": TileType.WEBP,
            "tile_compression": Compression.NONE,  # WebP is already compressed
            "min_lon_e7": e7(west), "min_lat_e7": e7(south),
            "max_lon_e7": e7(east), "max_lat_e7": e7(north),
            "center_zoom": minzoom + 2,
            "center_lon_e7": e7((west + east) / 2), "center_lat_e7": e7((south + north) / 2),
        }
        metadata = {
            "name": "Tonga orthophoto",
            "attribution": "LiDAR orthophoto",
            "format": "webp",
            "tileSize": tile_size,
            "minzoom": minzoom,
            "maxzoom": maxzoom,
            "tiles": written,
            "bounds3857": b3857,
            # Kept under the key the viewer already shows: ground m/px at maxzoom.
            "sourceResolution": round(ground, 2),
            **({"sourcePixelSize": source_pixel} if source_pixel else {}),
        }
        writer.finalize(header, metadata)
    staging.replace(out)
    return {"tiles": written, "empty": empty, "in_mb": src_bytes / 1e6,
            "out_mb": out.stat().st_size / 1e6, "metadata": metadata}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="orthophoto (ECW or GeoTIFF)")
    ap.add_argument("--out", type=Path, default=ROOT / "public/tonga/ortho.pmtiles")
    ap.add_argument("--work", type=Path, default=ROOT / ".ortho-build")
    ap.add_argument("--minzoom", type=int, default=10)
    ap.add_argument("--maxzoom", type=int, default=19,
                    help="z19 is 0.14 m/px here: the last level with real detail from 10 cm imagery")
    ap.add_argument("--from-xyz", type=Path, default=None,
                    help="skip tiling and pack an existing z/x/y tile directory")
    ap.add_argument("--quality", type=int, default=85, help="WebP quality (lossy)")
    ap.add_argument("--lossless", action="store_true", help="lossless WebP (much larger)")
    ap.add_argument("--keep-xyz", action="store_true", help="keep the intermediate PNG tiles")
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    pixel = None
    if args.from_xyz:
        xyz = args.from_xyz
    else:
        if not (QGIS_BIN / "gdalinfo").exists():
            print(f"error: QGIS not found at {QGIS}; it provides the ECW driver", file=sys.stderr)
            return 1
        xyz, pixel = tile_source(args.src, args.work, args.minzoom, args.maxzoom, args.workers)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    result = pack(xyz, args.out, args.quality, args.lossless, pixel, args.workers)
    print(f"done: {result['tiles']:,} tiles ({result['empty']:,} empty skipped), "
          f"{result['in_mb']:.0f} MB of PNG -> {result['out_mb']:.0f} MB {args.out}", flush=True)

    if not args.from_xyz and not args.keep_xyz:
        shutil.rmtree(xyz, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
