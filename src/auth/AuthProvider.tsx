/**
 * Frontend authentication + admin gating for SlabVault.
 *
 * This is DEFENSE IN DEPTH, not the only line of defence: the database RLS
 * policies and the Edge Function's `isCallerAdmin` check already prevent any
 * non-admin from reading or writing data. This provider adds the missing
 * frontend pieces — a real session, an explicit admin verification via
 * `is_admin(auth.uid())`, and the state a route guard needs so the app is
 * usable and protected routes can't render for the wrong user.
 *
 * Auth status is a small state machine:
 *   loading    — initial session read / admin check in flight
 *   signed_out — no Supabase session
 *   not_admin  — authenticated, but not in the slab_admins allowlist
 *   admin      — authenticated AND confirmed admin (the only state that may
 *                render protected content)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export type AuthStatus = "loading" | "signed_out" | "not_admin" | "admin";

export interface AuthUser {
  id: string;
  email: string | null;
}

/** A Supabase auth session, narrowed to the fields this provider reads. */
export type AuthSession = { user: { id: string; email?: string | null } } | null;

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
    signOut(): Promise<{ error: { message: string } | null }>;
  };
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Attempt an email/password sign-in. Resolves with an error message or null. */
  signIn(email: string, password: string): Promise<string | null>;
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
    async (session: { user: { id: string; email?: string | null } } | null) => {
      const gen = ++generation.current;
      if (!session?.user) {
        setUser(null);
        setStatus("signed_out");
        return;
      }
      const nextUser: AuthUser = { id: session.user.id, email: session.user.email ?? null };
      setUser(nextUser);
      setStatus("loading");
      const isAdmin = await checkAdmin(client, session.user.id);
      // A newer auth event superseded this check — discard the stale result.
      if (gen !== generation.current) return;
      setStatus(isAdmin ? "admin" : "not_admin");
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
    //    token refresh). Re-verifies admin on each transition.
    const { data } = client.auth.onAuthStateChange((_event, session) => {
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

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an <AuthProvider>.");
  return ctx;
}
