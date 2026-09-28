import { NextResponse, type NextRequest } from "next/server";
import { PRODUCTS_COOKIE, isProductsAuthed } from "@/lib/auth/productsAuth";

// The products pages, and the product files they load: without the second,
// anyone could fetch the images and statistics directly from public/.
export const config = {
  matcher: ["/pointcloud-products", "/pointcloud-products/:path*", "/tonga/products/:path*"],
};

export async function proxy(request: NextRequest) {
  if (await isProductsAuthed(request.cookies.get(PRODUCTS_COOKIE)?.value)) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith("/tonga/")) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const login = new URL("/products-login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}
