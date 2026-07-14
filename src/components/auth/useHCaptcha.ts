import { useCallback, useState } from "react";

export function useHCaptcha(setError: (message: string | null) => void) {
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const siteKey = String(import.meta.env.VITE_HCAPTCHA_SITE_KEY ?? "").trim();
  const enabled = siteKey.length > 0;
  const expire = useCallback(() => setToken(""), []);
  const fail = useCallback((message: string) => { setToken(""); setError(message); }, [setError]);
  const reset = useCallback(() => { setToken(""); setResetKey((value) => value + 1); }, []);
  return { siteKey, enabled, token, setToken, resetKey, expire, fail, reset };
}
