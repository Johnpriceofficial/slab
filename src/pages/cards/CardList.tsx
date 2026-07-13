import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Archive, Camera, Search } from "lucide-react";
import { PageHead } from "@/components/seo/PageHead";
import { LoadingState } from "@/components/shared/LoadingState";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { fetchCards } from "@/lib/cards/api";

export default function CardList() {
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const { data: cards = [], isLoading, error } = useQuery({
    queryKey: ["cards", status], queryFn: () => fetchCards(status),
  });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((card) => [card.card_name, card.set_name, card.card_number, card.rarity ?? ""].some((value) => value.toLowerCase().includes(q)));
  }, [cards, search]);

  return (
    <main className="container max-w-6xl py-8">
      <PageHead title="Scanned Cards · GradedCardValue.com" noindex />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Scanned Card Inventory</h1><p className="mt-1 text-sm text-muted-foreground">Raw cards identified through the live camera scanner.</p></div>
        <Button asChild><Link to="/scan-card"><Camera /> Scan Card</Link></Button>
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, set, number, or rarity" /></div>
        <Button variant={status === "active" ? "default" : "outline"} onClick={() => setStatus("active")}>Active</Button>
        <Button variant={status === "archived" ? "default" : "outline"} onClick={() => setStatus("archived")}><Archive /> Archived</Button>
      </div>
      {isLoading ? <LoadingState message="Loading scanned cards…" /> : error ? <p role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-destructive">{error instanceof Error ? error.message : "Inventory could not be loaded."}</p> : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-12 text-center"><Camera className="mx-auto mb-3 h-9 w-9 text-muted-foreground" /><h2 className="font-semibold">{search ? "No matching cards" : status === "active" ? "No scanned cards yet" : "No archived cards"}</h2>{!search && status === "active" && <Button className="mt-4" asChild><Link to="/scan-card">Scan your first card</Link></Button>}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((card) => (
            <Link key={card.id} to={`/cards/${card.id}`} className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Card className="h-full overflow-hidden transition group-hover:-translate-y-0.5 group-hover:shadow-lg">
                <div className="aspect-[5/7] overflow-hidden bg-slate-950">{card.thumbnail_url ? <img src={card.thumbnail_url} alt={`${card.card_name} scan`} className="h-full w-full object-contain transition group-hover:scale-[1.02]" /> : <div className="grid h-full place-items-center text-xs text-white/60">Private scan image</div>}</div>
                <CardContent className="p-4"><div className="flex items-start justify-between gap-2"><h2 className="font-semibold leading-tight">{card.card_name}</h2><Badge variant={card.identification_confidence >= 0.9 ? "secondary" : "outline"}>{Math.round(card.identification_confidence * 100)}%</Badge></div><p className="mt-2 text-sm text-muted-foreground">{card.set_name}</p><p className="text-sm font-medium">#{card.card_number}</p>{card.rarity && <p className="mt-2 text-xs text-muted-foreground">{card.rarity}</p>}</CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
