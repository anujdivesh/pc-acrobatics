import { NextResponse, type NextRequest } from "next/server";
import { PRODUCTS_COOKIE, PRODUCTS_PASSWORD, productsToken, safeNext } from "@/lib/auth/productsAuth";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNext(form.get("next"));

  if (form.get("password") !== PRODUCTS_PASSWORD) {
    const back = new URL("/products-login", request.url);
    back.searchParams.set("error", "1");
    back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(PRODUCTS_COOKIE, await productsToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // signed in for 12 hours
  });
  return response;
}
