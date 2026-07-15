/**
 * Adapters that map existing inventory records onto the canonical identity
 * input, so slabs and raw cards feed the SAME Master Identity Engine. These are
 * the only two places that know a record's field names; every consumer works
 * from the resulting CardIdentity.
 */

import type { Slab } from "@/lib/slabs/types";
import type { InventoryCard } from "@/lib/cards/api";
import { buildIdentity, type CardIdentity, type IdentityInput } from "./identity";

/** A graded slab's identity input — carries the specimen (grade/cert) fields. */
export function slabIdentityInput(slab: Slab): IdentityInput {
  return {
    card_name: slab.card_name,
    set: slab.set_name,
    card_number: slab.card_number,
    language: slab.language,
    rarity: slab.rarity,
    variation: slab.variation,
    year: slab.year,
    grader: slab.grader,
    grade: slab.grade,
    grade_label: slab.grade_label,
    certification_number: slab.certification_number,
    pricecharting_product_id: slab.pricecharting_product_id,
  };
}

/** A raw card's identity input — ungraded, so no specimen fields. */
export function cardIdentityInput(card: InventoryCard): IdentityInput {
  return {
    card_name: card.card_name,
    set: card.set_name,
    card_number: card.card_number,
    rarity: card.rarity,
  };
}

export function slabIdentity(slab: Slab): Promise<CardIdentity> {
  return buildIdentity(slabIdentityInput(slab));
}

export function cardIdentity(card: InventoryCard): Promise<CardIdentity> {
  return buildIdentity(cardIdentityInput(card));
}
