/**
 * Route guard: renders its children only for a confirmed admin.
 *
 *  loading    → a spinner (never flash protected content while deciding)
 *  signed_out → redirect to /login (remembering where they were headed)
 *  customer   → an explicit Access Denied page
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

  if (status === "customer" || status === "unverified") {
    return (
      <div className="container max-w-md py-20 text-center">
        <h1 className="mb-2 text-2xl font-bold">Access denied</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          You are signed in as <span className="font-medium">{user?.email ?? "an unknown account"}</span>, but this
          account can use the card scanner, but it is not authorized for administrative slab or marketplace tools.
        </p>
        <div className="flex justify-center gap-2">
          {status === "customer" && <Button asChild><a href="/scan-card">Open scanner</a></Button>}
          <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
