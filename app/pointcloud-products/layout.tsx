import type { Metadata } from "next";
import ProductsApp from "./_components/ProductsApp";

export const metadata: Metadata = {
  title: "Point cloud products · Pacific Ocean Portal",
  description: "Products derived from the Mango Island topo-bathy LiDAR survey, on the map.",
};

// The map lives here, not in the pages, so it stays mounted while moving between
// products: only the layers change, Cesium is not rebuilt.
export default function ProductsLayout({ children }: LayoutProps<"/pointcloud-products">) {
  return (
    <>
      <ProductsApp />
      {children}
    </>
  );
}
