/**
 * Frontend authentication for GradedCardValue.com customers and admins.
 *
 * This is DEFENSE IN DEPTH, not the only line of defence: the database RLS
 * policies and Edge Functions remain authoritative. This provider owns the
 * browser session, exposes customer account actions, and separately resolves
 * the immutable app-metadata admin role.
 *
 * Auth status is a small state machine:
 *   loading    — initial session read / admin check in flight
 *   signed_out — no Supabase session
 *   unverified — authenticated session whose email is not confirmed
 *   customer   — verified authenticated customer
 *   admin      — authenticated AND confirmed admin (the only state that may
 *                render administrative slab/marketplace content)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AuthStatus = "loading" | "signed_out" | "unverified" | "customer" | "admin";

export interface AuthUser {
  id: string;
  email: string | null;
}

/** A Supabase auth session, narrowed to the fields this provider reads. */
export type AuthSession = { user: { id: string; email?: string | null; email_confirmed_at?: string | null } } | null;

/**
 * The slice of the Supabase client this provider needs. The real `supabase`
 * client satisfies this structurally; tests inject a minimal fake.
 */
export interface AuthClient {
  auth: {
    getSession(): Promise<{ data: { session: AuthSession } }>;
    onAuthStateChange(
      cb: (event: string, session: AuthSession) => void,
    ): { data: { subscription: { unsubscribe(): void } } };
    signInWithPassword(creds: { email: string; password: string }): Promise<{ error: { message: string } | null }>;
    signUp(input: { email: string; password: string; options?: { emailRedirectTo?: string } }): Promise<{
      data: { session: AuthSession };
      error: { message: string } | null;
    }>;
    resetPasswordForEmail(email: string, options?: { redirectTo?: string }): Promise<{ error: { message: string } | null }>;
    updateUser(input: { password: string }): Promise<{ error: { message: string } | null }>;
    signOut(): Promise<{ error: { message: string } | null }>;
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Attempt an email/password sign-in. Resolves with an error message or null. */
  signIn(email: string, password: string): Promise<string | null>;
  signUp(email: string, password: string): Promise<{ error: string | null; needsVerification: boolean }>;
  requestPasswordReset(email: string): Promise<string | null>;
  updatePassword(password: string): Promise<string | null>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Resolve admin status for a user id via the SECURITY DEFINER is_admin RPC. */
async function checkAdmin(client: AuthClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("is_admin", { _user_id: userId });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

export function AuthProvider({
  children,
  client = supabase as unknown as AuthClient,
}: {
  children: React.ReactNode;
  client?: AuthClient;
}) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  // Guards against a stale async admin-check resolving after a newer auth event.
  const generation = useRef(0);

  const resolveSession = useCallback(
    async (session: { user: { id: string; email?: string | null; email_confirmed_at?: string | null } } | null) => {
      const gen = ++generation.current;
      if (!session?.user) {
        setUser(null);
        setStatus("signed_out");
        return;
      }
      const nextUser: AuthUser = { id: session.user.id, email: session.user.email ?? null };
      setUser(nextUser);
      if (session.user.email_confirmed_at === null) {
        setStatus("unverified");
        return;
      }
      setStatus("loading");
      const isAdmin = await checkAdmin(client, session.user.id);
      // A newer auth event superseded this check — discard the stale result.
      if (gen !== generation.current) return;
      setStatus(isAdmin ? "admin" : "customer");
    },
    [client],
  );

  useEffect(() => {
    let active = true;
    // 1. Read the current session on startup.
    client.auth.getSession().then(({ data }) => {
      if (active) void resolveSession(data.session);
    });
    // 2. Keep in sync with every subsequent auth-state change (sign-in, sign-out,
    //    token refresh). Re-verifies admin on each transition. Skip INITIAL_SESSION
    //    — getSession() above already resolves the initial load, so acting on it
    //    here would double the is_admin check on every mount.
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION") return;
      if (active) void resolveSession(session);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [client, resolveSession]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      const { error } = await client.auth.signInWithPassword({ email, password });
      // Admin re-verification happens in the onAuthStateChange handler.
      return error ? error.message : null;
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.auth.signOut();
    // onAuthStateChange will drive us to signed_out; set it eagerly too.
    generation.current++;
    setUser(null);
    setStatus("signed_out");
  }, [client]);

  const signUp = useCallback(async (email: string, password: string) => {
    const emailRedirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/login?confirmed=1`;
    const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo } });
    return { error: error?.message ?? null, needsVerification: !error && !data.session };
  }, [client]);

  const requestPasswordReset = useCallback(async (email: string) => {
    const redirectTo = typeof window === "undefined" ? undefined : `${window.location.origin}/reset-password`;
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
    return error?.message ?? null;
  }, [client]);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await client.auth.updateUser({ password });
    return error?.message ?? null;
  }, [client]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signUp, requestPasswordReset, updatePassword, signOut }),
    [status, user, signIn, signUp, requestPasswordReset, updatePassword, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an <AuthProvider>.");
  return ctx;
}
