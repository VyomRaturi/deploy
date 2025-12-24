"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Logout() {
  const router = useRouter();

  useEffect(() => {
    // Clear all auth-related data
    localStorage.clear();

    // Optional: also clear sessionStorage if used anywhere
    sessionStorage.clear();

    // Redirect to login page after logout
    router.replace("/login");
  }, [router]);

  return null;
}