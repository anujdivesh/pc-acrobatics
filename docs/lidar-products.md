# Deriving coastal products from topo-bathy LiDAR

How the products at `/pointcloud-products` are made from a single classified
point cloud, and how to make them again for another island.

Worked example: **Mango Island, Tonga**. A topo-bathy survey of 263 million
classified returns, one COPC file, plus a 10 cm orthophoto.

Everything below is implemented in [`scripts/build_products.py`](../scripts/build_products.py).
The code blocks are taken from that script and trimmed to the lines that matter.

---

## 1. The pipeline at a glance

```
topobathy.copc.laz
  │
  ├─ water level ── median Z of water-surface returns (ASPRS 9, 41) ── 0 m reference
  │
  └─ PDAL, binned per 1 m cell, one grid per role
       ├─ ground       class 2          mean   → land surface
       ├─ seabed       class 40         mean   → bathymetry
       └─ surface      classes 2–6      max    → top of canopy / roofs
            │
            ├─ land mask (ground above the water level, cleaned)
            │
            └─ five products ── numpy / scipy / scikit-image / shapely
                   │
                   ├─ map overlays   PNG, reprojected to lon/lat, 256-colour palette
                   ├─ vectors        GeoJSON (EPSG:4326)
                   └─ statistics     manifest.json
```

The web map reads `public/tonga/products/manifest.json` and draws the overlays,
vectors and charts it lists.

---

## 2. Tools

Everything runs in one conda / micromamba environment (`pcl`):

| Tool | Used for |
|---|---|
| **PDAL** 2.10 + `python-pdal` | Reading the COPC, filtering by class, gridding points into cells |
| **GDAL** 3.13 (`osgeo`) | Mosaicking grids, hole filling, reprojection of overlays |
| **numpy / scipy** | Array maths, labelling connected regions, filters, distance transforms |
| **scikit-image** | Contours, peak finding, watershed, small-object removal |
| **shapely / pyproj** | Geometry (contours, points, polygons), CRS transforms |
| **matplotlib** | Colour ramps only |
| **Pillow** | Writing the map overlays as PNG |

Create the environment if you don't have it:

```bash
micromamba create -n pcl -c conda-forge python=3.11 pdal python-pdal gdal \
    numpy scipy scikit-image shapely pyproj matplotlib pillow
```

Run the whole build:

```bash
micromamba run -n pcl python scripts/build_products.py
```

Timings for this survey on an 8-core laptop:
- about 4 minutes from scratch;
- about 2 minutes on reruns, because the grids are cached in `.products-build/`;
- `--regrid` forces the grids to be rebuilt.

---

## 3. Input data

| | |
|---|---|
| Point cloud | `public/tonga/topobathy.copc.laz`: 263,229,541 points, COPC (LAZ 1.4) |
| CRS | WGS 84 / UTM zone 1S (EPSG:32701); Z in metres, **no vertical datum declared** |
| Classes present | 1 unassigned, 2 ground, 3/4/5 low/medium/high vegetation, 6 building, 7 noise, 9 water surface, 40 bathymetric bottom |

List the classes in a file quickly by reading one coarse octree level:

```bash
cat > /tmp/classes.json <<'EOF'
{"pipeline":[
  {"type":"readers.copc","filename":"public/tonga/topobathy.copc.laz","resolution":5.0},
  {"type":"filters.stats","dimensions":"Classification","count":"Classification"}
]}
EOF
pdal pipeline /tmp/classes.json --metadata=/tmp/meta.json
```

---

## 4. Shared preparation

### 4.1 The vertical reference: measured water level

The file's Z values are heights above the WGS84 ellipsoid. That puts the sea surface
at about 53 m, not 0. Every product needs "height above the sea", so the first step
measures the sea surface from the data itself: the median Z of the water-surface
returns.

```python
pipeline = [
    {"type": "readers.copc", "filename": src, "resolution": 5.0},   # coarse read: seconds
    {"type": "filters.expression", "expression": "Classification == 9 || Classification == 41"},
]
p = pdal.Pipeline(json.dumps(pipeline)); p.execute()
water_level = float(np.median(np.concatenate([a["Z"] for a in p.arrays])))   # 52.97 m
```

**All heights in every product are `Z − 52.97`.** So 0 is the sea surface at survey
time. It's not mean sea level or a tidal datum; see [§8](#8-limits).

### 4.2 Gridding: one statistic per 1 m cell

PDAL's `writers.gdal` turns points into a raster. Two settings matter:
- **`binmode: true`**: each point only counts toward the cell it falls in. Without
  it, `writers.gdal` averages everything within `resolution × √2` of each cell
  centre, which smooths the surface across neighbouring cells.
- **`output_type`**: `mean` for the ground and seabed surfaces, `max` for the top of
  canopy.

```python
pipeline = [
    {"type": "readers.copc", "filename": src,
     "bounds": f"([{x0},{x1}],[{y0},{y1}])", "threads": 2},   # COPC reads only this block
    {"type": "filters.expression", "expression": "Classification == 2"},
    {"type": "writers.gdal", "filename": out, "resolution": 1.0,
     "output_type": "mean", "binmode": True, "window_size": 0,
     "origin_x": x0, "origin_y": y0, "width": w, "height": h,
     "data_type": "float32", "nodata": -9999},
]
```

A full 1 m grid is about 10,500 × 6,100 cells, so the survey is gridded in
2 km blocks, 6 at a time in parallel.
- **Blocks share one grid:** every block origin is snapped to the same 1 m grid,
  so the blocks tile exactly.
- **Mosaic:** the blocks are joined with `gdal.BuildVRT` and `gdal.Translate`.
- **CRS stamp:** `writers.gdal` leaves the CRS off a block that received no
  points, and `gdalbuildvrt` then silently drops every block whose CRS differs
  from the first one. So the script stamps the CRS on every block before the
  mosaic.

The three grids, all relative to the water level:

```python
ground    = fill_holes(grid([2],             "mean", "ground"),    g, 3) - wl
seabed    = fill_holes(grid([40],            "mean", "seabed"),    g, 3) - wl
dsm       =            grid([2, 3, 4, 5, 6], "max",  "surface")        - wl
```

### 4.3 Filling holes, and only small ones

A 1 m cell with no return is left empty (NaN). `fill_holes(arr, grid, px)` uses
`gdal.FillNodata` (inverse-distance from the gap's edge) with a maximum search
distance.
- **3 cells for the main grids:** this fills pinholes between returns only.
  Larger gaps, such as surf zones or deep water with no bottom return, stay empty
  rather than invented.
- **25 cells for ground under dense canopy** (`ground_filled`): the canopy-height
  product needs a ground surface there, so this one is filled
  further.

### 4.4 The land mask

```python
land = ~np.isnan(ground) & (ground > 0)              # ground returns above the water level
land = morphology.remove_small_objects(land, 200)    # drop specks < 200 m²
land = morphology.remove_small_holes(land, 200)      # close holes < 200 m²
land &= ~np.isnan(ground)                            # but keep only cells with a real height
```

Result: **87.5 ha of land** across 5 islands.

---

## 5. The five products

### 5.1 Hypsometry

**Question:** how much of the land is low-lying?

**Method:**
- Take the heights of all land cells.
- Build the cumulative distribution in 0.5 m bins: % of land below each height.
- Map the land in height bands (0–1, 1–2, 2–5, 5–10, 10–20, > 20 m).

```python
h = ground[land]
edges = np.arange(0, math.ceil(h.max()) + 0.5, 0.5)
counts, _ = np.histogram(h, bins=edges)
curve = np.concatenate([[0], np.cumsum(counts)]) / h.size * 100
pct_below = {t: (h < t).mean() * 100 for t in (1, 2, 5, 10)}
```

**Result:**
- Share of land below each height: 8.9% below 1 m, 18.1% below 2 m, 53.6% below
  5 m, 68.4% below 10 m.
- Median height 4.1 m; highest point 39.5 m.

### 5.2 Bathymetry

**Question:** how deep is the water, and where?

**Method:**
- **Depth grid:** `depth = −seabed`, from the bathymetric-bottom returns only
  (class 40).
- **Contours:** at 2, 5, 10, 20 and 30 m. They're drawn on a lightly smoothed copy
  (NaN-aware Gaussian, σ = 2 m) so lines don't zig-zag cell to cell. Lines shorter
  than 60 m are dropped, and the rest are simplified to 1 m.
- **Statistics:** area by depth band.

```python
depth = -seabed
smooth = nan_filter(depth, ndimage.gaussian_filter, sigma=2.0)   # normalised convolution
for level in (2, 5, 10, 20, 30):
    for c in measure.find_contours(np.nan_to_num(smooth, nan=-99), level):
        line = LineString(pixel_to_utm(c)).simplify(1.0)
```

`nan_filter` is a normalised convolution: it filters the values and the
valid-cell mask separately, then divides one by the other. That way the gaps
don't bleed zeros into the result.

**Result:**
- 1,431 ha of seabed; deepest 45.5 m, mean 16.9 m.
- 3.6 ha of reef dries (seabed above the water level).

### 5.3 Reef rugosity and slope

**Question:** how structurally complex is the seabed?

**Method:**
- **Slope:** from the seabed gradient.
- **Rugosity:** surface area over planar area. For a surface `z(x, y)` that's
  `√(1 + (∂z/∂x)² + (∂z/∂y)²)`, averaged over 5 × 5 m windows. 1.0 is perfectly
  flat.

```python
gy, gx = np.gradient(seabed, 1.0)
rugosity = nan_filter(np.sqrt(1 + gx**2 + gy**2), ndimage.uniform_filter, size=5)
slope = np.degrees(np.arctan(np.hypot(gx, gy)))
```

**Result:**
- Mean rugosity 1.03; mean slope 9.6°.
- The reef flat is near-flat (1.007, 3.5°); the reef slopes are steeper (about
  11°).

A 1 m grid under-represents coral-scale roughness. Use the native point spacing
or a 0.25–0.5 m grid for habitat work.

### 5.4 Canopy height and trees

**Question:** how tall is the vegetation, and where are the trees?

**Method:**
1. **Canopy height:** `CHM = surface (max of classes 2–6) − ground`, on land,
   clipped to 0–50 m. Canopy is where CHM ≥ 2 m.
2. **Tree tops:** local peaks of the smoothed CHM (Gaussian σ = 1 m), at least
   3 m tall and 3 m apart (`skimage.feature.peak_local_max`).
3. **Crown areas:** crowns are grown from the tree tops over the canopy by
   watershed (`skimage.segmentation.watershed` on `−CHM`). Each tree records the
   area of its crown.

```python
chm = dsm - ground_filled
smooth = ndimage.gaussian_filter(chm, 1.0)
peaks = feature.peak_local_max(smooth, min_distance=3, threshold_abs=3.0)
markers[peaks[:, 0], peaks[:, 1]] = np.arange(1, len(peaks) + 1)
crowns = segmentation.watershed(-smooth, markers, mask=chm >= 2)
crown_area = np.bincount(crowns.ravel())[1:]              # m² per tree at 1 m
```

**Result:** 4,253 trees, 56% canopy cover (49 ha), mean tree height 12.5 m,
tallest 26 m.

**Tune for other forests:** `min_distance` controls how close two trees can be,
and `threshold_abs` sets the minimum tree height.

### 5.5 Tsunami safe zones

**Question:** where is the high ground to evacuate to?

**Method:** land above 5, 10 and 15 m, shown together as nested height bands
(5–10 m, 10–15 m, above 15 m).

```python
edges = [5, 10, 15, 1e9]
rgba, legend = bands(ground, edges, ["#86efac", "#22c55e", "#15803d"], land & (ground >= 5),
                     ["5–10 m", "10–15 m", "Above 15 m"])
```

**Result:**

| Safe above | Area | Share of land |
|---|---|---|
| 5 m | 40.6 ha | 46.4% |
| 10 m | 27.6 ha | 31.6% |
| 15 m | 17.0 ha | 19.4% |

The smaller islands have no ground above 5 m.

---

## 6. From arrays to the map

### Overlays

Each raster product becomes a colour image with transparency (RGBA) in the
survey's UTM grid, and is then:
1. reprojected to lon/lat at 2 m with `gdal.Warp` (`resampleAlg="average"`, with
   the alpha band as the mask);
2. cropped to its visible pixels, with the crop rectangle recorded;
3. saved as a PNG with a 256-colour palette (`Image.quantize`), which is about 3×
   smaller than full colour.

The map draws each PNG over its rectangle with Cesium's `SingleTileImageryProvider`.

### Colours

- **Continuous products** use a single-hue sequential ramp from matplotlib:
  - depth: Blues
  - rugosity: Oranges
  - slope: Purples
  - canopy height: Greens
- **Classed products** use hand-picked bands:
  - hypsometry: yellow → brown
  - tsunami safe areas: light → dark green by height
- Legends are written into the manifest from the same values, so the legend always
  matches the map.

### Vectors

Vectors are shapely geometries in UTM, transformed to EPSG:4326 with pyproj.
Coordinates are rounded to 6 decimal places (about 10 cm) and written as GeoJSON.

### The manifest

`manifest.json` lists, per product:
- **overlays:** URL, rectangle and label;
- **vectors:** URL, style and feature count;
- **legend;**
- **statistics.**

The web app ([`app/pointcloud-products/`](../app/pointcloud-products/)) needs
nothing else.

---

## 7. Related pipelines (terrain and orthophoto)

The 3D viewer at `/pointcloud` uses two more products built from the same data.

**Terrain:** [`scripts/build_cesium_terrain.py`](../scripts/build_cesium_terrain.py)
→ `terrain.pmtiles`.
- **DEM:** a binned-mean grid of classes 2 + 40 at 0.5 m (checked: 100% of cells
  equal the mean of their points to within 0.002 mm).
- **Gap fill:** gaps are filled with a *pull-push* interpolation, so there are no
  cliffs where data is missing. Outside the survey, heights are eased over 3 km to
  a far-field height.
- **Tiles:** quantized-mesh tiles, z0–19, with mesh simplification that accounts
  for the Earth's curvature. Each tile's horizon-culling point is computed exactly
  as Cesium computes it.
- **Packing:** the tiles are packed into one PMTiles archive, gzipped.

```bash
micromamba run -n pcl python scripts/build_cesium_terrain.py            # all stages
micromamba run -n pcl python scripts/build_cesium_terrain.py --stage tiles
```

**Orthophoto:** [`scripts/build_ortho_pmtiles.py`](../scripts/build_ortho_pmtiles.py)
→ `ortho.pmtiles`.
- **Reading the ECW:** QGIS's GDAL, which has the licensed ECW driver, builds a
  band-tagged VRT; band 4 is checked to be alpha, not near-infrared.
- **Tiling:** `gdal2tiles` makes 512 px tiles at z10–19.
- **Packing:** the tiles are converted to WebP (quality 85, alpha kept) and packed
  into PMTiles. Empty tiles are skipped.

```bash
micromamba run -n pcl python scripts/build_ortho_pmtiles.py
micromamba run -n pcl python scripts/build_ortho_pmtiles.py --from-xyz path/to/tiles
```

---

## 8. Limits

| Limit | Affects | What would fix it |
|---|---|---|
| 0 m is the sea surface **at survey time**, not a tidal datum | Hypsometry, tsunami | A local tide gauge or geoid-to-chart-datum offset; subtract it instead of the measured water level |
| No vertical datum in the file | All heights | Confirm with the survey provider; the water-surface returns at about 53 m suggest ellipsoidal heights |
| No bottom return in surf and deep water | Bathymetry, rugosity | Nothing in this survey; those areas are left empty, not interpolated |
| 1 m grid | Rugosity reads low; small beach features are smoothed | Rerun at 0.5 m (set `RES`); gridding is fast, but the tree step gets slower |

---

## 9. Reusing this for another island

1. **Prepare the point cloud:** produce a COPC with the same ASPRS classes (see
   `web-lidar/docs/tonga-pipeline.md` for merging and converting the delivered
   LAS).
2. **Check the classes and vertical reference:** see §3. You need water-surface
   returns (9 or 41) for the automatic water level. If there are none, set the
   water level by hand in `main()`.
3. **Point the script at your data:**

   ```bash
   micromamba run -n pcl python scripts/build_products.py \
       --src public/<island>/topobathy.copc.laz \
       --out public/<island>/products
   ```

4. **Adjust parameters where your island differs.** They're arguments in the
   `steps` list in `main()`:
   - tsunami heights.

   These are constants in the product functions:
   - tree peak spacing and height.
5. **Point the map at the new manifest:** change `MANIFEST_URL` in
   `app/pointcloud-products/_components/ProductsApp.tsx`.
