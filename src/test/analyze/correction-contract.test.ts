import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CORRECT_SLAB_IDENTIFICATION_FIELDS,
  OPERATIONS,
  type CorrectAnalysisRequest,
  type CorrectSlabIdentificationResponse,
  type CorrectSlabIdentificationWireRequest,
} from "../../../contracts/backend-operations";
import proposedState from "../../../contracts/proposed/PROPOSED_STATE.json";

const byName = new Map(OPERATIONS.map((op) => [op.name, op]));

const migrationSql = readFileSync(
  "supabase/migrations/20260908000000_slab_permission_model.sql",
  "utf8",
);

describe("correction contract (correctAnalysis -> rpc:correct_slab_identification)", () => {
  it("maps correctAnalysis to the deployed correction RPC, not the revoked V1 table patch", () => {
    const op = byName.get("correctAnalysis")!;
    expect(op.backendResource).toEqual(["rpc:correct_slab_identification"]);
    expect(op.backendResource).not.toContain("table:slabs");
    expect(op.domain).toBe("analysis");
    expect(op.role).toBe("customer");
    expect(op.writes).toBe(true);
    expect(op.reads).toBe(false);
  });

  it("publishes the operation READY and browser-customer-safe, with the correction recorded", () => {
    const op = byName.get("correctAnalysis")!;
    expect(op.status).toBe("READY");
    expect(op.classification).toBe("BROWSER_CUSTOMER_SAFE");
    expect(proposedState.operationStatus.correctAnalysis).toBe("READY");
    expect(proposedState.contractCorrections.correctAnalysis).toContain(
      "rpc:correct_slab_identification",
    );
  });

  it("states the self-owned-only rule — administrators included — without hedging", () => {
    const op = byName.get("correctAnalysis")!;
    expect(op.authorization).toContain("self-owned only");
    expect(op.authorization).toContain("administrators included");
    expect(op.authorization).toContain("not_found");
    expect(op.authorization).toContain("EXECUTE revoked from public/anon");
  });

  it("declares the exact whitelist the deployed migration enforces", () => {
    // Parse v_allowed from the canonical migration so the manifest constant can
    // never drift from the SQL that production actually runs.
    const allowedBlock = migrationSql.match(
      /v_allowed constant text\[\] := array\[([\s\S]*?)\];/i,
    );
    expect(allowedBlock).not.toBeNull();
    const sqlFields = [...allowedBlock![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...CORRECT_SLAB_IDENTIFICATION_FIELDS]).toEqual(sqlFields);
    expect(CORRECT_SLAB_IDENTIFICATION_FIELDS).toHaveLength(15);
  });

  it("keeps ownership, valuation and inventory identity out of the whitelist", () => {
    for (const forbidden of [
      "owner_id",
      "inventory_number",
      "inventory_code",
      "front_image_path",
      "back_image_path",
      "final_value_cents",
      "status",
    ]) {
      expect(CORRECT_SLAB_IDENTIFICATION_FIELDS).not.toContain(forbidden);
    }
  });

  it("types the request as whitelisted-only and the wire body positionally", () => {
    const request: CorrectAnalysisRequest = {
      slabId: "b2c3d4e5-0000-4000-8000-000000000009",
      corrections: { card_name: "Charizard", year: 1999, notes: "corrected by owner" },
      idempotencyKey: "slabfix-1",
    };
    expect(Object.keys(request)).toEqual(["slabId", "corrections", "idempotencyKey"]);
    // @ts-expect-error owner_id is not correctable; the RPC refuses it and the type forbids it.
    const stolen: CorrectAnalysisRequest = { slabId: "x", corrections: { owner_id: "y" } };
    expect(stolen).toBeTruthy();

    const wire: CorrectSlabIdentificationWireRequest = {
      p_slab_id: request.slabId,
      p_corrections: request.corrections,
      p_idempotency_key: request.idempotencyKey,
    };
    expect(Object.keys(wire).sort()).toEqual([
      "p_corrections",
      "p_idempotency_key",
      "p_slab_id",
    ]);
  });

  it("types the response as the deployed soft-error jsonb shape", () => {
    const applied: CorrectSlabIdentificationResponse = {
      ok: true,
      replayed: false,
      slab_id: "b2c3d4e5-0000-4000-8000-000000000009",
      changes: { card_name: "Charizard" },
    };
    expect(applied.ok).toBe(true);
    const refused: CorrectSlabIdentificationResponse = {
      ok: false,
      error: "field_not_correctable",
      field: "owner_id",
    };
    expect(refused.ok).toBe(false);
    const suspended: CorrectSlabIdentificationResponse = {
      ok: false,
      error: "account_suspended",
    };
    expect(suspended.ok).toBe(false);
    // @ts-expect-error typed refusals are soft jsonb errors, never a bare string result.
    const legacy: CorrectSlabIdentificationResponse = { result: "applied" };
    expect(legacy).toBeTruthy();
  });

  it("documents the load-bearing call semantics in the manifest notes", () => {
    const notes = byName.get("correctAnalysis")!.notes ?? "";
    // Refusals are returned, not raised.
    expect(notes).toContain("SOFT");
    // Success does not return the corrected row; callers refetch.
    expect(notes).toContain("refetch");
    // Replay safety exists only with a caller-supplied key.
    expect(notes).toContain("p_idempotency_key");
    expect(notes).toContain("idempotency_conflict");
    // The one raw failure mode left: a non-numeric year raises on ::integer.
    expect(notes).toContain("year");
    expect(byName.get("correctAnalysis")!.idempotent).toBe(true);
    expect(byName.get("correctAnalysis")!.retriable).toBe(false);
  });

  it("matches the deployed audit surface: correction events plus canonical audit log", () => {
    const op = byName.get("correctAnalysis")!;
    expect(op.sideEffects).toContain("slab_correction_events");
    expect(op.sideEffects).toContain("audit_log");
    expect(migrationSql).toContain("insert into public.slab_correction_events");
    expect(migrationSql).toContain("'slab.identification_corrected'");
  });
});
