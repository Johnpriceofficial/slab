import { Navigate, useLocation } from "react-router-dom";
import { LoadingState } from "@/components/shared/LoadingState";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/auth/AuthProvider";

/** Allows verified customers and admins while preserving the requested URL. */
export function ProtectedUserRoute({ children }: { children: React.ReactNode }) {
  const { status, user, signOut } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <div className="container py-12"><LoadingState message="Checking your account…" /></div>;
  }
  if (status === "signed_out") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (status === "unverified") {
    return (
      <div className="container max-w-md py-20 text-center">
        <h1 className="mb-2 text-2xl font-bold">Verify your email</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Open the verification email sent to {user?.email ?? "your address"}, then return and sign in.
        </p>
        <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>
      </div>
    );
  }
  return <>{children}</>;
}
