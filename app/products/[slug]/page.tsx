import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PRODUCTS, productBySlug } from "../_data/products";

export function generateStaticParams() {
  return PRODUCTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/products/[slug]">): Promise<Metadata> {
  const product = productBySlug((await params).slug);
  return { title: product ? `${product.title} · Point cloud products` : "Point cloud products" };
}

// The layout draws the map and picks the product from the address; this page only
// rejects addresses that are not a product.
export default async function ProductPage({ params }: PageProps<"/products/[slug]">) {
  if (!productBySlug((await params).slug)) notFound();
  return null;
}
