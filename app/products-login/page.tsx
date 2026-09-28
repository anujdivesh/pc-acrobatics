import type { Metadata } from "next";
import { safeNext } from "@/lib/auth/productsAuth";

export const metadata: Metadata = { title: "Sign in · Point cloud products" };

export default async function ProductsLogin({ searchParams }: PageProps<"/products-login">) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error === "1";

  return (
    <main className="fixed inset-0 flex items-center justify-center bg-slate-900 p-4 font-sans">
      <form
        action="/api/products-login"
        method="post"
        className="w-full max-w-xs rounded-xl border border-zinc-300 bg-white p-5 shadow-lg"
      >
        <p className="text-sm font-semibold text-sky-600">Pacific Ocean Portal</p>
        <h1 className="mb-4 text-base font-semibold text-zinc-900">Point cloud products</h1>
        <input type="hidden" name="next" value={next} />
        <label className="block text-xs text-zinc-600">
          Password
          <input
            type="password"
            name="password"
            required
            autoFocus
            autoComplete="current-password"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-600"
          />
        </label>
        {error && <p className="mt-2 text-xs text-red-600">Wrong password.</p>}
        <button
          type="submit"
          className="mt-4 w-full rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
