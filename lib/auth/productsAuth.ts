/**
 * Password gate for /pointcloud-products and its data.
 *
 * Checked on the server only (proxy.ts and the login route), so the password
 * never reaches the browser. The cookie holds a hash of it, not the password.
 */
export const PRODUCTS_PASSWORD = "Ocean1234";
export const PRODUCTS_COOKIE = "pcp_auth";
export const PRODUCTS_HOME = "/pointcloud-products";

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cookie value a correct login earns. */
export const productsToken = () => sha256(`pointcloud-products:${PRODUCTS_PASSWORD}`);

export async function isProductsAuthed(cookie: string | undefined): Promise<boolean> {
  return !!cookie && cookie === (await productsToken());
}

/** Only ever send people back inside the products section. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith(PRODUCTS_HOME) ? next : PRODUCTS_HOME;
}
