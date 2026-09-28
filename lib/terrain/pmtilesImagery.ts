import type * as CesiumType from "cesium";
import { PMTiles, TileType } from "pmtiles";
import type { OrthoMeta } from "./types";

type Cesium = typeof CesiumType;

const MIME: Partial<Record<TileType, string>> = {
  [TileType.Png]: "image/png",
  [TileType.Jpeg]: "image/jpeg",
  [TileType.Webp]: "image/webp",
  [TileType.Avif]: "image/avif",
};

/**
 * Open a raster PMTiles archive and wrap it as a Cesium imagery provider.
 *
 * Cesium has no PMTiles support of its own; this answers its tile requests with
 * byte ranges read out of the one file. Zoom range, tile size, extent and the
 * rest come from the archive's header and metadata, so nothing else needs
 * configuring when it is rebuilt.
 */
export async function openPmtilesImagery(
  Cesium: Cesium,
  url: string,
  credit: string,
): Promise<{ provider: CesiumType.ImageryProvider; meta: OrthoMeta }> {
  const archive = new PMTiles(url);
  const header = await archive.getHeader();
  const metadata = (await archive.getMetadata()) as Partial<OrthoMeta>;
  const mime = MIME[header.tileType];
  if (!mime) throw new Error(`${url}: not a raster PMTiles archive`);

  const tileSize = metadata.tileSize ?? 512;
  const meta: OrthoMeta = {
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    tileSize,
    format: metadata.format ?? mime.split("/")[1],
    tiles: metadata.tiles ?? header.numAddressedTiles,
    bounds3857: metadata.bounds3857 ?? [0, 0, 0, 0],
    sourceResolution: metadata.sourceResolution ?? 0,
  };

  // Tiles with nothing in them were never written; Cesium still asks for them.
  const empty = document.createElement("canvas");
  empty.width = empty.height = 1;

  const provider = {
    tileWidth: tileSize,
    tileHeight: tileSize,
    minimumLevel: header.minZoom,
    maximumLevel: header.maxZoom,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    rectangle: Cesium.Rectangle.fromDegrees(header.minLon, header.minLat, header.maxLon, header.maxLat),
    tileDiscardPolicy: undefined,
    errorEvent: new Cesium.Event(),
    credit: new Cesium.Credit(credit),
    proxy: undefined,
    hasAlphaChannel: true,
    getTileCredits: () => [],
    pickFeatures: () => undefined,
    async requestImage(x: number, y: number, level: number) {
      const tile = await archive.getZxy(level, x, y);
      if (!tile) return empty;
      // Decoded exactly as ImageryProvider.loadImage does it. Imagery textures are
      // uploaded expecting a vertically flipped bitmap; without flipY every tile
      // is drawn upside down and the drape breaks into bands at tile rows.
      const src = URL.createObjectURL(new Blob([tile.data], { type: mime }));
      try {
        return await new Cesium.Resource({ url: src })
          .fetchImage({ preferImageBitmap: true, flipY: true });
      } finally {
        URL.revokeObjectURL(src);
      }
    },
  };
  return { provider: provider as unknown as CesiumType.ImageryProvider, meta };
}
