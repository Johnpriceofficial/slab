import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ENV = (((globalThis as Record<string, unknown>).process as { env?: Record<string, string | undefined> } | undefined)?.env ?? {}) as Record<string, string | undefined>;
const URL = ENV.SLABVAULT_TEST_URL;
const ANON = ENV.SLABVAULT_TEST_ANON_KEY;
const SERVICE = ENV.SLABVAULT_TEST_SERVICE_KEY;
const LIVE = Boolean(URL && ANON && SERVICE);
const looksProd = /joyrent|party|rhodeisland|mycousin|prod|rcbwemkfcefarqnlgrmv/i.test(URL ?? "");
const suite = LIVE && !looksProd ? describe : describe.skip;

suite("buildout integrity hardening", () => {
  let service: SupabaseClient;
  let admin: SupabaseClient;
  let adminId = "";
  const slabIds: string[] = [];
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;

  beforeAll(async () => {
    service = createClient(URL!, SERVICE!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `integrity-service-${stamp}` } });
    const email = `integrity-${stamp}@slabvault.test`;
    const password = `Integrity-${stamp}`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { graded_card_value_admin: true } });
    if (created.error || !created.data.user) throw created.error ?? new Error("admin creation failed");
    adminId = created.data.user.id;
    await service.from("slab_admins").insert({ user_id: adminId });
    admin = createClient(URL!, ANON!, { auth: { persistSession: false, autoRefreshToken: false, storageKey: `integrity-admin-${stamp}` } });
    const signed = await admin.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
  });

  afterAll(async () => {
    await service.from("slab_settings").update({ allow_hard_delete: false }).eq("id", true);
    if (slabIds.length) await service.from("slabs").delete().in("id", slabIds);
    await service.schema("private").from("slab_storage_cleanup_queue").delete().like("storage_path", `%${stamp}%`);
    if (adminId) await service.auth.admin.deleteUser(adminId).catch(() => {});
  });

  async function createSlab(cert: string) {
    const result = await admin.rpc("create_slab", {
      p: {
        card_name: "Kyurem ex",
        grader: "CGC",
        grade: "10",
        grade_label: "PRISTINE",
        certification_number: cert,
        set_name: "Black Bolt",
        card_number: "160/086",
        year: 2025,
        language: "Japanese",
        rarity: "Super Rare",
        variation: "Super Rare - Holo",
        label_description: "Kyurem ex Pokémon Japanese Black Bolt Super Rare - Holo",
        verification_status: "unverified",
        valuation_provenance: "tier_unavailable",
      },
      p_front_ext: "jpg",
      p_back_ext: null,
    });
    expect(result.error).toBeNull();
    const row = (Array.isArray(result.data) ? result.data[0] : result.data) as {
      id: string;
      inventory_number: number;
      inventory_code: string;
      game_or_franchise: string | null;
      finish: string | null;
      acquired_at: string | null;
    };
    slabIds.push(row.id);
    return row;
  }

  it("derives Pokémon/Holo and sets acquired_at from the first original image only", async () => {
    const slab = await createSlab(`INT-A-${stamp}`);
    expect(slab.game_or_franchise).toBe("Pokémon");
    expect(slab.finish).toBe("Holo");
    expect(slab.acquired_at).toBeNull();

    const firstAt = "2026-01-15T23:30:00.000Z";
    const inserted = await service.from("slab_images").insert({
      slab_id: slab.id,
      image_role: "front",
      storage_path: `slabs/${slab.inventory_number}/original/front-${stamp}.jpg`,
      mime_type: "image/jpeg",
      sha256: "a".repeat(64),
      is_original: true,
      created_at: firstAt,
      owner_id: adminId,
    });
    expect(inserted.error).toBeNull();

    const current = await service.from("slabs").select("acquired_at").eq("id", slab.id).single();
    expect(current.error).toBeNull();
    expect(current.data?.acquired_at).toBe("2026-01-15");

    const later = await service.from("slab_images").insert({
      slab_id: slab.id,
      image_role: "back",
      storage_path: `slabs/${slab.inventory_number}/original/back-${stamp}.jpg`,
      mime_type: "image/jpeg",
      sha256: "b".repeat(64),
      is_original: true,
      created_at: "2026-02-20T00:00:00.000Z",
      owner_id: adminId,
    });
    expect(later.error).toBeNull();
    const unchanged = await service.from("slabs").select("acquired_at").eq("id", slab.id).single();
    expect(unchanged.data?.acquired_at).toBe("2026-01-15");
  });

  it("permanently rejects public inventory ID reassignment and compaction", async () => {
    const slab = await createSlab(`INT-ID-${stamp}`);
    const moved = await admin.rpc("reassign_slab_inventory_id", { p_slab_id: slab.id, p_sequence: 900001 });
    expect(moved.error?.message ?? "").toMatch(/INVENTORY_ID_IMMUTABLE/i);
    const compacted = await admin.rpc("compact_slab_inventory_ids");
    expect(compacted.error?.message ?? "").toMatch(/INVENTORY_ID_IMMUTABLE/i);
  });

  it("retains audit/tombstone evidence and queues originals plus derivatives on purge", async () => {
    const slab = await createSlab(`INT-D-${stamp}`);
    const imagePath = `slabs/${slab.inventory_number}/original/front-${stamp}.jpg`;
    const derivativePath = `slabs/${slab.inventory_number}/derived/front-${stamp}.webp`;
    const image = await service.from("slab_images").insert({
      slab_id: slab.id,
      image_role: "front",
      storage_path: imagePath,
      mime_type: "image/jpeg",
      sha256: "c".repeat(64),
      is_original: true,
      owner_id: adminId,
    }).select("id").single();
    expect(image.error).toBeNull();
    const derivative = await service.from("image_derivatives").insert({
      slab_image_id: image.data!.id,
      derivative_type: "browser_decode",
      storage_path: derivativePath,
      transform_manifest: { operation: "decode", generative: false },
      width: 100,
      height: 100,
      sha256: "d".repeat(64),
      owner_id: adminId,
    });
    expect(derivative.error).toBeNull();

    await service.from("slab_settings").update({ allow_hard_delete: true }).eq("id", true);
    const purged = await admin.rpc("purge_slabs", { p_ids: [slab.id] });
    expect(purged.error).toBeNull();

    const deleted = await service.from("slabs").select("id").eq("id", slab.id).maybeSingle();
    expect(deleted.data).toBeNull();
    const audit = await service.from("audit_log").select("id, action").eq("entity_type", "slab").eq("entity_id", slab.id).eq("action", "hard_delete");
    expect(audit.error).toBeNull();
    expect(audit.data?.length).toBe(1);
    const tombstone = await service.schema("private").from("slab_deletion_tombstones").select("slab_id, inventory_code").eq("slab_id", slab.id).single();
    expect(tombstone.error).toBeNull();
    expect(tombstone.data?.inventory_code).toBe(slab.inventory_code);
    const queued = await service.schema("private").from("slab_storage_cleanup_queue").select("storage_path").eq("slab_id", slab.id);
    expect(queued.error).toBeNull();
    const paths = (queued.data ?? []).map((row) => row.storage_path);
    expect(paths).toEqual(expect.arrayContaining([imagePath, derivativePath]));

    const index = slabIds.indexOf(slab.id);
    if (index >= 0) slabIds.splice(index, 1);
  });
});
