/**
 * Route guard: renders its children only for a confirmed admin.
 *
 *  loading    → a spinner (never flash protected content while deciding)
 *  signed_out → redirect to /login (remembering where they were headed)
 *  not_admin  → an explicit Access Denied page (NOT a silent redirect, so an
 *               authenticated non-admin gets a clear reason)
 *  admin      → the protected content
 *
 * This complements — never replaces — the backend RLS + Edge Function admin
 * checks, which remain the authoritative enforcement.
 */

import { Navigate, useLocation } from "react-router-dom";
import { LoadingState } from "@/components/shared/LoadingState";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthProvider";

export function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const { status, user, signOut } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="container py-12">
        <LoadingState message="Checking access…" />
      </div>
    );
  }

  if (status === "signed_out") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (status === "not_admin") {
    return (
      <div className="container max-w-md py-20 text-center">
        <h1 className="mb-2 text-2xl font-bold">Access denied</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          You are signed in as <span className="font-medium">{user?.email ?? "an unknown account"}</span>, but this
          account is not authorized for GradedCardValue.com. Ask an administrator to grant your account access.
        </p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
