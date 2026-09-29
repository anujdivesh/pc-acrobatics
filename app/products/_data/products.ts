/** The products listed on the map. They are built by scripts/build_products.py. */
export type Product = { slug: string; title: string };

export const PRODUCTS: Product[] = [
  { slug: "elevation", title: "Elevation" },
  { slug: "bathymetry", title: "Bathymetry" },
  { slug: "reef-rugosity", title: "Reef roughness" },
  { slug: "canopy-height", title: "Trees" },
  { slug: "tsunami-safe-zones", title: "Tsunami safe zones" },
];

export const productBySlug = (slug: string) => PRODUCTS.find((p) => p.slug === slug);
