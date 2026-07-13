import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Signup() {
  const { status, signUp } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (status === "admin" || status === "customer") return <Navigate to="/scan-card" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 10) return setError("Use at least 10 characters for your password.");
    if (password !== confirmPassword) return setError("Passwords do not match.");
    setSubmitting(true);
    setError(null);
    const result = await signUp(email.trim(), password);
    setSubmitting(false);
    if (result.error) return setError(result.error);
    setSent(result.needsVerification);
  };

  return (
    <main className="container flex min-h-screen max-w-md flex-col justify-center py-12">
      <PageHead title="Create account · GradedCardValue.com" noindex />
      <Card>
        <CardHeader><CardTitle>Create your account</CardTitle></CardHeader>
        <CardContent>
          {sent ? (
            <div className="space-y-4 text-sm"><p className="rounded-md border border-green-600/30 bg-green-600/5 p-3 text-green-700">Check your email and open the verification link before signing in.</p><Button className="w-full" asChild><Link to="/login">Return to sign in</Link></Button></div>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <Field label="Email" id="signup-email" type="email" autoComplete="email" value={email} setValue={setEmail} />
              <Field label="Password" id="signup-password" type="password" autoComplete="new-password" value={password} setValue={setPassword} />
              <Field label="Confirm password" id="signup-confirm" type="password" autoComplete="new-password" value={confirmPassword} setValue={setConfirmPassword} />
              {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={submitting}>{submitting && <Loader2 className="animate-spin" />} Create account</Button>
              <p className="text-center text-sm text-muted-foreground">Already registered? <Link className="font-medium text-primary hover:underline" to="/login">Sign in</Link></p>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

function Field({ label, id, type, autoComplete, value, setValue }: { label: string; id: string; type: string; autoComplete: string; value: string; setValue(value: string): void }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}</Label><Input id={id} type={type} autoComplete={autoComplete} value={value} onChange={(event) => setValue(event.target.value)} required /></div>;
}
