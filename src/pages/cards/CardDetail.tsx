import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Archive, ArrowLeft, Check, Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHead } from "@/components/seo/PageHead";
import { LoadingState } from "@/components/shared/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchCard, setCardArchived, updateCard } from "@/lib/cards/api";

export default function CardDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: card, isLoading, error } = useQuery({ queryKey: ["card", id], queryFn: () => fetchCard(id), enabled: !!id });
  const [form, setForm] = useState({ card_name: "", set_name: "", card_number: "", rarity: "", condition_notes: "" });
  useEffect(() => { if (card) setForm({ card_name: card.card_name, set_name: card.set_name, card_number: card.card_number, rarity: card.rarity ?? "", condition_notes: card.condition_notes ?? "" }); }, [card]);

  const save = useMutation<Awaited<ReturnType<typeof updateCard>>, Error, boolean>({
    mutationFn: async (allowDuplicate: boolean) => updateCard({ card_id: id, ...form, allow_duplicate: allowDuplicate }),
    onSuccess: async (result) => {
      if (result.status === "possible_duplicate") {
        if (window.confirm("Another copy with this exact name, set, and number exists. Save this card as an additional copy?")) await save.mutateAsync(true);
        return;
      }
      toast.success("Card updated.");
      await Promise.all([queryClient.invalidateQueries({ queryKey: ["card", id] }), queryClient.invalidateQueries({ queryKey: ["cards"] })]);
    },
    onError: (reason) => toast.error(reason instanceof Error ? reason.message : "Card could not be updated."),
  });

  const archive = async () => {
    if (!card) return;
    const nextArchived = card.inventory_status !== "archived";
    if (nextArchived && !window.confirm("Archive this card? It will leave active inventory but its scan evidence will be preserved.")) return;
    try { await setCardArchived(id, nextArchived); toast.success(nextArchived ? "Card archived." : "Card restored."); await queryClient.invalidateQueries({ queryKey: ["cards"] }); navigate("/cards"); } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Inventory status could not be changed."); }
  };

  if (isLoading) return <main className="container py-12"><LoadingState message="Loading card…" /></main>;
  if (error || !card) return <main className="container max-w-lg py-16 text-center"><h1 className="text-2xl font-bold">Card unavailable</h1><p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : "This card was not found."}</p><Button className="mt-5" asChild><Link to="/cards">Back to cards</Link></Button></main>;

  return (
    <main className="container max-w-5xl py-8">
      <PageHead title={`${card.card_name} · GradedCardValue.com`} noindex />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><Button variant="ghost" asChild><Link to="/cards"><ArrowLeft /> Scanned Cards</Link></Button><div className="flex gap-2"><Badge variant="outline">OPENAI</Badge><Badge variant={card.inventory_status === "active" ? "secondary" : "outline"}>{card.inventory_status}</Badge></div></div>
      <div className="grid gap-6 lg:grid-cols-[minmax(280px,420px)_1fr]">
        <Card className="overflow-hidden"><div className="bg-slate-950 p-4">{card.image_url ? <img src={card.image_url} alt={`${card.card_name} original scanner capture`} className="mx-auto max-h-[650px] w-full rounded-xl object-contain" /> : <div className="grid aspect-[5/7] place-items-center text-sm text-white/60">Private image unavailable</div>}</div><CardContent className="p-4 text-xs text-muted-foreground"><p>Original live-camera evidence · private signed access</p><p className="mt-1">Scanned {new Date(card.scan?.created_at ?? card.created_at).toLocaleString()}</p>{card.scan?.model && <p className="mt-1">Model: {card.scan.model} · Schema: {card.scan.schema_version}</p>}</CardContent></Card>
        <div className="space-y-5">
          <Card><CardHeader><CardTitle>Card Identity</CardTitle></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2"><Field label="Card name" value={form.card_name} onChange={(value) => setForm((old) => ({ ...old, card_name: value }))} /><Field label="Set" value={form.set_name} onChange={(value) => setForm((old) => ({ ...old, set_name: value }))} /><Field label="Card number" value={form.card_number} onChange={(value) => setForm((old) => ({ ...old, card_number: value }))} /><Field label="Rarity" value={form.rarity} onChange={(value) => setForm((old) => ({ ...old, rarity: value }))} /><label className="sm:col-span-2 text-sm font-medium">Condition notes<Textarea className="mt-1 min-h-28" value={form.condition_notes} onChange={(event) => setForm((old) => ({ ...old, condition_notes: event.target.value }))} /></label><div className="sm:col-span-2 flex flex-wrap justify-between gap-2 border-t pt-4"><div className="text-sm"><span className="text-muted-foreground">Identification confidence</span><p className="font-semibold">{Math.round(card.identification_confidence * 100)}%</p></div><Button onClick={() => save.mutate(false)} disabled={save.isPending || !form.card_name.trim() || !form.set_name.trim() || !form.card_number.trim()}>{save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save changes</Button></div></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">Inventory Status</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">Archiving removes this card from active inventory while preserving its original scan and audit history.</p><Button variant="outline" onClick={() => void archive()}>{card.inventory_status === "archived" ? <><RotateCcw /> Restore to active inventory</> : <><Archive /> Archive card</>}</Button></CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">Evidence Status</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><p className="flex items-center gap-2"><Check className="text-green-600" /> Original capture preserved</p><p className="flex items-center gap-2"><Check className="text-green-600" /> Strict structured identification stored</p><p className="text-xs text-muted-foreground">Condition observations are visual estimates, not professional grading.</p></CardContent></Card>
        </div>
      </div>
    </main>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return <label className="text-sm font-medium">{label}<Input className="mt-1" value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}
