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
      <h1 className="pointer-events-none absolute left-5 top-3 z-10 font-sans text-2xl font-semibold tracking-tight text-sky-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)]">
        Pacific Ocean Portal
      </h1>
      <SidePanel />
      <ToolsPanel />
      </TerrainLayerProvider>
      </PointCloudProvider>
      </MapProvider>
    </main>
  );
}
