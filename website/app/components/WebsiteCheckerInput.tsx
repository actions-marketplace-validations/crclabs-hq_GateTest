"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function WebsiteCheckerInput() {
  const [url, setUrl] = useState("");
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    router.push(`/scan/url?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 w-full max-w-lg">
      <input
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://mywebsite.com"
        aria-label="Website URL to scan"
        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/25 text-sm focus:outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/30 transition-all"
      />
      <button
        type="submit"
        disabled={!url.trim()}
        className="px-5 py-3 rounded-xl bg-white/8 border border-white/12 text-white/70 font-semibold text-sm hover:bg-white/12 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      >
        Check →
      </button>
    </form>
  );
}
