import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Slab } from "@/lib/slabs/types";
import { supabaseSlabDataAccess, updateSlab } from "@/lib/slabs/data";
import { EditSlabDialog } from "@/pages/slabs/SlabDetail";

vi.mock("@/lib/slabs/data", () => ({
  supabaseSlabDataAccess: { checkCertification: vi.fn() },
  updateSlab: vi.fn(),
  fetchSlabById: vi.fn(),
  fetchAdjacentSlabs: vi.fn(),
  signedImageUrl: vi.fn(),
  refreshSlabPricing: vi.fn(),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/select", async () => {
  const ReactModule = await import("react");
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => (
      <select value={value} onChange={(event) => onValueChange(event.target.value)}>{children}</select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <ReactModule.Fragment>{children}</ReactModule.Fragment>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
  };
});

const draft: Slab = {
  id: "draft-1",
  inventory_number: 41,
  inventory_prefix: "S",
  inventory_sequence: 41,
  inventory_code: "S0041",
  card_name: null,
  final_value_cents: null,
  quick_sale_value_cents: null,
  replacement_value_cents: null,
  grader: null,
  grade: null,
  grade_label: null,
  certification_number: null,
  set_name: null,
  card_number: null,
  year: null,
  language: null,
  rarity: null,
  variation: null,
  label_description: null,
  label_accuracy: "accurate",
  verification_status: "unverified",
  valuation_confidence: null,
  valuation_provenance: "tier_unavailable",
  duplicate_status: "unique",
  pricecharting_product_id: null,
  pricecharting_product_name: null,
  pricecharting_grade_field: null,
  pricecharting_value_cents: null,
  pricecharting_sales_volume: null,
  pricecharting_match_status: null,
  price_variance_percent: null,
  front_image_path: "slabs/41/front.jpg",
  back_image_path: null,
  notes: null,
  date_valued: null,
  created_at: "2026-07-13T00:00:00Z",
  updated_at: "2026-07-13T00:00:00Z",
};

describe("draft detail edit workflow", () => {
  it("shows shared blockers, then saves a completed draft as verified", async () => {
    vi.mocked(supabaseSlabDataAccess.checkCertification).mockResolvedValue(null);
    vi.mocked(updateSlab).mockResolvedValue({ ...draft, verification_status: "verified" });
    const onSaved = vi.fn();
    render(<EditSlabDialog slab={draft} onSaved={onSaved} />);

    const verification = screen.getAllByRole("combobox").find((node) => (node as HTMLSelectElement).value === "unverified")!;
    fireEvent.change(verification, { target: { value: "verified" } });
    expect(screen.getByText(/Cannot verify until you add: Card name, Grader, Grade, Certification number/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Card Name"), { target: { value: "Rayquaza VMAX" } });
    fireEvent.change(screen.getByLabelText("Grader"), { target: { value: "CGC" } });
    fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Certification #"), { target: { value: "000047" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateSlab).toHaveBeenCalledWith("draft-1", expect.objectContaining({
      card_name: "Rayquaza VMAX",
      grader: "CGC",
      grade: "10",
      certification_number: "000047",
      verification_status: "verified",
    })));
    expect(supabaseSlabDataAccess.checkCertification).toHaveBeenCalledWith("CGC", "000047");
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("blocks a changed grader/cert that belongs to another slab", async () => {
    vi.mocked(supabaseSlabDataAccess.checkCertification).mockResolvedValue({ id: "other", inventory_number: 7 });
    vi.mocked(updateSlab).mockClear();
    render(<EditSlabDialog slab={draft} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Grader"), { target: { value: "PSA" } });
    fireEvent.change(screen.getByLabelText("Certification #"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(supabaseSlabDataAccess.checkCertification).toHaveBeenCalledWith("PSA", "123"));
    expect(updateSlab).not.toHaveBeenCalled();
  });
});
