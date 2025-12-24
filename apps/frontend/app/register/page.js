"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import Image from "next/image"; // Assuming you want to show the logo like the main app
import { setToken, decodeToken } from "../lib/auth";
import Link from "next/link";

// Signup schema: email + password + Binance keys
const signupSchema = z
  .object({
    email: z.string().email("Enter a valid email address"),
    password: z.string().min(6, "Password must be at least 6 characters long"),
    confirmPassword: z.string().min(6, "Confirm your password"),
    binanceApiKey: z.string().min(1, "Binance API key is required"),
    binanceSecretKey: z.string().min(1, "Binance secret key is required"),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export default function SignupPage() {
  const router = useRouter();

  const [form, setForm] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    binanceApiKey: "",
    binanceSecretKey: "",
  });
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(false);
  const [serverMsg, setServerMsg] = useState("");

  function handleChange(e) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
    // Clear specific field error when user types
    if (errors[e.target.name]) {
      setErrors((prev) => ({ ...prev, [e.target.name]: undefined }));
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setErrors({});
    setServerMsg("");

    const parsed = signupSchema.safeParse(form);
    if (!parsed.success) {
      const fieldErrors = {};
      parsed.error.issues.forEach((err) => {
        const key = err.path?.[0] || "form";
        fieldErrors[key] = err.message;
      });
      setErrors(fieldErrors);
      return;
    }

    try {
      setLoading(true);
      const baseUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8080").replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          binanceApiKey: form.binanceApiKey,
          binanceSecretKey: form.binanceSecretKey,
        }),
      });

      const data = await res.json();
      if (!data.ok) {
        setServerMsg(data.error || "Sign up failed");
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

  // Shared Input Component for consistency
  const InputField = ({ label, name, type = "text", placeholder }) => (
    <div>
      <label className="block text-xs font-medium text-neutral-400 mb-1.5 ml-1">
        {label}
      </label>
      <div className={`flex items-center px-3 py-2.5 rounded-lg border transition-all ${errors[name]
        ? "bg-rose-950/10 border-rose-500/50 focus-within:border-rose-500"
        : "bg-[#09090b] border-white/10 focus-within:border-white/30"
        }`}>
        <input
          name={name}
          type={type}
          value={form[name]}
          onChange={handleChange}
          className="bg-transparent text-sm w-full outline-none text-neutral-200 placeholder:text-neutral-600"
          placeholder={placeholder}
          autoComplete="off"
        />
      </div>
      {errors[name] && <p className="text-xs text-rose-400 mt-1.5 ml-1">{errors[name]}</p>}
    </div>
  );

  return (
    <main className="min-h-screen w-full flex items-center justify-center bg-[#09090b] text-neutral-200 p-4">
      <div className="w-full max-w-md space-y-6">

        {/* Header / Logo */}
        <div className="flex flex-col items-center text-center space-y-2">
          <div className="flex items-center gap-2 mb-2">
            <Image src="/logo.svg" alt="Logo" className="invert opacity-90" width={150} height={100} />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Create an account</h1>
          <p className="text-sm text-neutral-400">Enter your Binance Testnet keys to get started.</p>
        </div>

        {/* Card */}
        <div className="bg-[#111] border border-white/10 rounded-2xl p-6 md:p-8 shadow-2xl shadow-black/50">
          <form onSubmit={onSubmit} className="space-y-5">
            <InputField label="Email" name="email" type="email" placeholder="name@example.com" />

            <div className="grid grid-cols-2 gap-4">
              <InputField label="Password" name="password" type="password" placeholder="••••••" />
              <InputField label="Confirm" name="confirmPassword" type="password" placeholder="••••••" />
            </div>

            <div className="space-y-5 pt-2">
              <div className="flex items-center gap-2">
                <div className="h-px bg-white/10 flex-1"></div>
                <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-semibold">API Keys</span>
                <div className="h-px bg-white/10 flex-1"></div>
              </div>
              <InputField label="Binance API Key" name="binanceApiKey" placeholder="Paste your API Key" />
              <InputField label="Binance Secret Key" name="binanceSecretKey" type="password" placeholder="Paste your Secret Key" />
              <Link href="https://testnet.binance.vision" target="_blank" className="text-xs text-neutral-400 hover:underline underline-offset-4 decoration-neutral-700 transition-all">
                Don't have Testnet keys? Create them here.
              </Link>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 text-sm font-bold bg-white text-black rounded-lg hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all active:scale-[0.98] mt-2"
            >
              {loading ? "Creating account..." : "Sign Up"}
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
          Already have an account?{" "}
          <button onClick={() => router.push("/login")} className="text-white hover:underline underline-offset-4 decoration-neutral-700 transition-all">
            Sign in
          </button>
        </p>
      </div>
    </main>
  );
}