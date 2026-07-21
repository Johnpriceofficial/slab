import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AuthStatus = "loading" | "signed_out" | "unverified" | "customer" | "admin";

export interface AuthUser { id: string; email: string | null }
export type AuthSession = { user: { id: string; email?: string | null; email_confirmed_at?: string | null } } | null;

export interface AuthClient {
  auth: {
    getSession(): Promise<{ data: { session: AuthSession } }>;
    onAuthStateChange(cb: (event: string, session: AuthSession) => void): { data: { subscription: { unsubscribe(): void } } };
    signInWithPassword(creds: { email: string; password: string; options?: { captchaToken?: string } }): Promise<{ error: { message: string } | null }>;
    signUp(input: { email: string; password: string; options?: { emailRedirectTo?: string; captchaToken?: string } }): Promise<{ data: { session: AuthSession }; error: { message: string } | null }>;
    resetPasswordForEmail(email: string, options?: { redirectTo?: string; captchaToken?: string }): Promise<{ error: { message: string } | null }>;
    updateUser(input: { password: string }): Promise<{ error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  signIn(email: string, password: string, captchaToken?: string): Promise<string | null>;
  signUp(email: string, password: string, captchaToken?: string): Promise<{ error: string | null; needsVerification: boolean }>;
  requestPasswordReset(email: string, captchaToken?: string): Promise<string | null>;
  updatePassword(password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function checkAdmin(client: AuthClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("is_admin", { _user_id: userId });
    return !error && data === true;
  } catch {
    return false;
  }
}

export function AuthProvider({ children, client = supabase as unknown as AuthClient }: { children: React.ReactNode; client?: AuthClient }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const generation = useRef(0);

  // Tracks the user id we last fully resolved to admin/customer, so a
  // background re-verification for the SAME user (Supabase fires
  // onAuthStateChange on token refresh, and often on tab focus too) never
  // flashes the loading spinner over whatever page is already on screen.
  // Only a genuinely new session (sign-in, or a different user id) should
  // show "Checking your account…" while we resolve it.
  const resolvedAdminUserId = useRef<string | null>(null);

  const resolveSession = useCallback(async (session: AuthSession) => {
    const gen = ++generation.current;
    if (!session?.user) {
      resolvedAdminUserId.current = null;
      setUser(null);
      setStatus("signed_out");
      return;
    }
    setUser({ id: session.user.id, email: session.user.email ?? null });
    if (session.user.email_confirmed_at === null) {
      resolvedAdminUserId.current = null;
      setStatus("unverified");
      return;
    }
    const isBackgroundRefreshForSameUser = resolvedAdminUserId.current === session.user.id;
    if (!isBackgroundRefreshForSameUser) setStatus("loading");
    const isAdmin = await checkAdmin(client, session.user.id);
    if (gen === generation.current) {
      resolvedAdminUserId.current = session.user.id;
      setStatus(isAdmin ? "admin" : "customer");
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    client.auth.getSession().then(({ data }) => { if (active) void resolveSession(data.session); });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event !== "INITIAL_SESSION" && active) void resolveSession(session);
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client, resolveSession]);

  const signIn = useCallback(async (email: string, password: string, captchaToken?: string) => {
    const { error } = await client.auth.signInWithPassword({ email, password, ...(captchaToken ? { options: { captchaToken } } : {}) });
    return error?.message ?? null;
  }, [client]);

  const signUp = useCallback(async (email: string, password: string, captchaToken?: string) => {
    const emailRedirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/login?confirmed=1`;
    const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo, ...(captchaToken ? { captchaToken } : {}) } });
    return { error: error?.message ?? null, needsVerification: !error && !data.session };
  }, [client]);

  const requestPasswordReset = useCallback(async (email: string, captchaToken?: string) => {
    const redirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/reset-password`;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo, ...(captchaToken ? { captchaToken } : {}) });
    return error?.message ?? null;
  }, [client]);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await client.auth.updateUser({ password });
    return error?.message ?? null;
  }, [client]);

  const signOut = useCallback(async () => {
    await client.auth.signOut();
    generation.current++;
    setUser(null);
    setStatus("signed_out");
  }, [client]);

  const value = useMemo<AuthContextValue>(() => ({ status, user, signIn, signUp, requestPasswordReset, updatePassword, signOut }), [status, user, signIn, signUp, requestPasswordReset, updatePassword, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an <AuthProvider>.");
  return ctx;
}
