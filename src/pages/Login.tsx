/**
 * Email/password sign-in for GradedCardValue.com customers and admins.
 *
 * On a successful sign-in the AuthProvider re-verifies admin status; once the
 * status becomes "admin" this page redirects to wherever the user was headed
 * (or /dashboard). An authenticated non-admin is bounced to the guard's
 * Access Denied screen so the reason is explicit.
 */

import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";

interface LocationState {
  from?: string;
}

export default function Login() {
  const { status, signIn } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Clear a stale error once the user edits either field.
  useEffect(() => {
    if (error) setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password]);

  const dest = (location.state as LocationState | null)?.from || "/scan-card";

  if (status === "admin" || status === "customer") return <Navigate to={dest} replace />;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const message = await signIn(email.trim(), password);
    setSubmitting(false);
    if (message) setError(message);
    // On success the provider flips status; the redirects above take over.
  };

  return (
    <div className="container flex min-h-screen max-w-md flex-col justify-center py-12">
      <PageHead title="Sign in · GradedCardValue.com" noindex />
      <Card>
        <CardHeader>
          <CardTitle>Sign in to GradedCardValue.com</CardTitle>
        </CardHeader>
        <CardContent>
          {searchParams.get("confirmed") === "1" && (
            <p className="mb-4 rounded-md border border-green-600/30 bg-green-600/5 p-3 text-sm text-green-700">
              Email confirmed. You can sign in now.
            </p>
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="email" className="text-xs">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="password" className="text-xs">
                Password
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || status === "loading"}>
              {submitting || status === "loading" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
          </form>
          <div className="mt-4 flex items-center justify-between text-sm">
            <Link className="text-primary hover:underline" to="/forgot-password">Forgot password?</Link>
            <Link className="font-medium text-primary hover:underline" to="/signup">Create account</Link>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Each account receives a private card inventory. Your scans are not shared with other customers.</p>
        </CardContent>
      </Card>
    </div>
  );
}
