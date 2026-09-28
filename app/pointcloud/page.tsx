import CesiumMap from "@/components/CesiumMap";
import SidePanel from "@/components/SidePanel";
import ToolsPanel from "@/components/ToolsPanel";
import { MapProvider } from "@/components/MapProvider";
import { PointCloudProvider } from "@/components/PointCloudProvider";
import { TerrainLayerProvider } from "@/components/TerrainProvider";

export default function Home() {
  return (
    <main className="fixed inset-0">
      <MapProvider>
      <PointCloudProvider>
      <TerrainLayerProvider>
      <CesiumMap />
      <h1 className="pointer-events-none absolute left-3 top-3 z-10 whitespace-nowrap font-sans text-sm font-semibold md:left-5 md:text-2xl tracking-tight text-sky-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
        Pacific Ocean Portal - PC Viewer
      </h1>
      <SidePanel />
      <ToolsPanel />
      </TerrainLayerProvider>
      </PointCloudProvider>
      </MapProvider>
    </main>
  );
}
