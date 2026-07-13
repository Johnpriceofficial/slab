import { createClient } from "@supabase/supabase-js";

// GradedCardValue.com talks to the same Supabase project that holds the `slabs` /
// `slab_comps` tables, the `slab-images` bucket, and the `pricecharting-search`
// edge function. Set these in `.env.local` (see `.env.example`).
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Don't hard-crash at import; surface a clear console warning instead so the
  // UI still renders and network calls fail with an explainable error.
  console.warn(
    "[GradedCardValue.com] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. " +
      "Copy .env.example to .env.local and fill them in.",
  );
}

export const supabase = createClient(
  SUPABASE_URL ?? "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY ?? "placeholder-anon-key",
  {
    auth: {
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
  },
);
