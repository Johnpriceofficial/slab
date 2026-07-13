import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/auth/AuthProvider";
import { PageHead } from "@/components/seo/PageHead";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    const message = await requestPasswordReset(email.trim());
    setSubmitting(false); if (message) setError(message); else setSent(true);
  };
  return <main className="container flex min-h-screen max-w-md flex-col justify-center py-12"><PageHead title="Reset password · GradedCardValue.com" noindex /><Card><CardHeader><CardTitle>Reset your password</CardTitle></CardHeader><CardContent>{sent ? <div className="space-y-4 text-sm"><p>Check your email for a secure password-reset link.</p><Button className="w-full" asChild><Link to="/login">Return to sign in</Link></Button></div> : <form className="space-y-4" onSubmit={submit}><div className="space-y-1"><Label htmlFor="reset-email">Email</Label><Input id="reset-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button className="w-full" type="submit" disabled={submitting}>{submitting && <Loader2 className="animate-spin" />} Send reset link</Button><p className="text-center text-sm"><Link className="text-primary hover:underline" to="/login">Back to sign in</Link></p></form>}</CardContent></Card></main>;
}
