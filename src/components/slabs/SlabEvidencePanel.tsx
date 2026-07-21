import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fetchFieldEvidence } from "@/lib/slabs/data";
import { backImageStatus } from "@/lib/slabs/back-image-status";
import type { Slab } from "@/lib/slabs/types";

function State({ label, value, source }: { label: string; value: string; source: string }) {
  return <div className="rounded border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="font-medium">{value}</p><Badge variant="outline" className="mt-1">{source}</Badge></div>;
}

export function SlabEvidencePanel({ slab }: { slab: Slab }) {
  const { data: evidence = [] } = useQuery({ queryKey: ["field-evidence", slab.id], queryFn: () => fetchFieldEvidence(slab.id) });
  const back = backImageStatus(slab.back_image_path);
  return <div className="mt-6 space-y-6">
    <Card><CardHeader><CardTitle>Verification</CardTitle></CardHeader><CardContent className="grid gap-3 sm:grid-cols-4">
      <State label="Visual Identity" value={slab.visual_identity_status === "verified" ? "Verified" : slab.visual_identity_status === "rejected" ? "Rejected" : "Needs Review"} source="PHOTO + OPENAI" />
      <State label="PriceCharting Match" value={slab.pricecharting_match_status ?? "Unlinked"} source="PRICECHARTING" />
      <State label="Certification Database" value={slab.certification_verification_status === "verified" ? "Verified" : "Not Checked"} source="CGC: NOT INTEGRATED" />
      <State label="Valuation" value={(slab.valuation_status ?? "unavailable").replace(/_/g, " ")} source={slab.valuation_status === "manual" ? "USER" : "PRICECHARTING"} />
      {/* Back image is a verification input — surface its absence rather than omitting it silently. */}
      <State label="Back Image" value={back.label} source="PHOTO" />
    </CardContent>
    {back.note && <p className="px-6 pb-4 text-xs text-amber-600">{back.note}</p>}
    </Card>
    <Card><CardHeader><CardTitle>Field Evidence</CardTitle></CardHeader><CardContent>
      {evidence.length === 0 ? <p className="text-sm text-muted-foreground">No linked OpenAI evidence run is stored for this record.</p> : <div className="grid gap-2 sm:grid-cols-2">
        {evidence.map((row) => <div key={row.id} className="rounded border p-2 text-sm"><div className="flex justify-between gap-2"><span className="font-medium">{row.field_name.replace(/_/g, " ")}</span><Badge variant="outline">OPENAI</Badge></div><p>{row.value ?? "Unreadable"}</p><p className="text-xs text-muted-foreground">{row.readability ?? "unknown"} · {row.confidence == null ? "—" : `${Math.round(row.confidence * 100)}%`} · Proposed, not certification-database verification</p></div>)}
      </div>}
    </CardContent></Card>
  </div>;
}
