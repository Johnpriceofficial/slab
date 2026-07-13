import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ResetPassword() {
  const { status, updatePassword } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  if (status === "signed_out") return <Navigate to="/forgot-password" replace />;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 10) return setError("Use at least 10 characters for your password.");
    if (password !== confirm) return setError("Passwords do not match.");
    setSubmitting(true); const message = await updatePassword(password); setSubmitting(false);
    if (message) setError(message); else setSaved(true);
  };
  return <main className="container flex min-h-screen max-w-md flex-col justify-center py-12"><PageHead title="Choose password · GradedCardValue.com" noindex /><Card><CardHeader><CardTitle>Choose a new password</CardTitle></CardHeader><CardContent>{saved ? <Button className="w-full" asChild><Link to="/scan-card">Continue to scanner</Link></Button> : <form className="space-y-4" onSubmit={submit}><div><Label htmlFor="new-password">New password</Label><Input id="new-password" className="mt-1" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div><div><Label htmlFor="confirm-new-password">Confirm password</Label><Input id="confirm-new-password" className="mt-1" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button className="w-full" type="submit" disabled={submitting}>{submitting && <Loader2 className="animate-spin" />} Save password</Button></form>}</CardContent></Card></main>;
}
