import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authEnabled, safeNext } from "@/lib/auth/site";
import { withBase } from "@/lib/basePath";

export const metadata: Metadata = { title: "Sign in · Pacific Ocean Portal" };

export default async function Login({ searchParams }: PageProps<"/login">) {
  // Read the request first: that makes the page render per request, so the
  // login setting below comes from the running server's environment, not from
  // the build machine's (where it would be baked in as a permanent redirect).
  const params = await searchParams;
  // No login configured (local development): nothing to sign in to.
  if (!authEnabled()) redirect("/");
  const next = safeNext(params.next);
  const error = params.error === "1";

  return (
    <main className="fixed inset-0 flex items-center justify-center bg-slate-900 p-4 font-sans">
      <form
        action={withBase("/api/login")}
        method="post"
        className="w-full max-w-xs rounded-xl border border-zinc-300 bg-white p-5 shadow-lg"
      >
        <h1 className="mb-4 text-base font-semibold text-sky-600">Pacific Ocean Portal - PC Viewer</h1>
        <input type="hidden" name="next" value={next} />
        <label className="block text-xs text-zinc-600">
          Username
          <input
            type="text"
            name="username"
            required
            autoFocus
            autoComplete="username"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-600"
          />
        </label>
        <label className="mt-3 block text-xs text-zinc-600">
          Password
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="mt-1 block w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-blue-600"
          />
        </label>
        {error && <p className="mt-2 text-xs text-red-600">Wrong username or password.</p>}
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
