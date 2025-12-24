"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import Image from "next/image";
import { setToken, decodeToken } from "../lib/auth";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters long"),
});

export default function LoginPage() {
  const router = useRouter();

  const [form, setForm] = useState({ email: "", password: "" });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [serverMsg, setServerMsg] = useState("");

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    if (errors[e.target.name]) {
      setErrors((prev) => ({ ...prev, [e.target.name]: undefined }));
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErrors({});
    setServerMsg("");

    const parsed = loginSchema.safeParse(form);
    if (!parsed.success) {
      const fieldErrors = {};
      parsed.error.errors.forEach((err) => {
        fieldErrors[err.path[0]] = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    try {
      setLoading(true);
      const baseUrl = (process.env.NEXT_PUBLIC_BACKEND_URL).replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (!data.ok) {
        setServerMsg(data.error || "Login failed");
        return;
      }

      setToken(data.token);
      const decoded = decodeToken();
      const userId = decoded?.userId || decoded?.id || decoded?.sub || null;
      if (userId) localStorage.setItem("userId", String(userId));

      router.push("/trade");
    } catch (err) {
      setServerMsg("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-[#09090b] text-neutral-200 p-4">
      <div className="w-full max-w-[400px] space-y-6">

        {/* Header */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Image src="/logo.svg" alt="Logo" className="invert opacity-90" width={150} height={100} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Welcome back</h1>
          <p className="text-sm text-neutral-400">Enter your details to access your portfolio.</p>
        </div>

        {/* Card */}
        <div className="bg-[#111] border border-white/10 rounded-2xl p-6 md:p-8 shadow-2xl shadow-black/50">
          <form onSubmit={onSubmit} className="space-y-5">

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5 ml-1">Email</label>
              <div className={`flex items-center px-3 py-2.5 rounded-lg border transition-all ${errors.email ? "bg-rose-950/10 border-rose-500/50" : "bg-[#09090b] border-white/10 focus-within:border-white/30"}`}>
                <input
                  name="email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  className="bg-transparent text-sm w-full outline-none text-neutral-200 placeholder:text-neutral-600"
                  placeholder="name@example.com"
                  autoComplete="email"
                />
              </div>
              {errors.email && <p className="text-xs text-rose-400 mt-1.5 ml-1">{errors.email}</p>}
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-400 mb-1.5 ml-1">Password</label>
              <div className={`flex items-center px-3 py-2.5 rounded-lg border transition-all ${errors.password ? "bg-rose-950/10 border-rose-500/50" : "bg-[#09090b] border-white/10 focus-within:border-white/30"}`}>
                <input
                  name="password"
                  type="password"
                  value={form.password}
                  onChange={handleChange}
                  className="bg-transparent text-sm w-full outline-none text-neutral-200 placeholder:text-neutral-600"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </div>
              {errors.password && <p className="text-xs text-rose-400 mt-1.5 ml-1">{errors.password}</p>}
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 text-sm font-bold bg-white text-black rounded-lg hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98] mt-2"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>

          {serverMsg && (
            <div className="mt-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-sm text-center">
              {serverMsg}
            </div>
          )}
        </div>

        {/* Footer Link */}
        <p className="text-center text-sm text-neutral-500">
          Don’t have an account?{" "}
          <button onClick={() => router.push("/register")} className="text-white hover:underline underline-offset-4 decoration-neutral-700 transition-all">
            Sign up
          </button>
        </p>
      </div>
    </main>
  );
}