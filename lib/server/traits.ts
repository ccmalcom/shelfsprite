import type { schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

export type TraitRow = typeof schema.tasteTraits.$inferSelect;

/** Port of api.py's TraitOut serialization — trait row -> wire JSON. */
export function traitOut(t: TraitRow) {
  return {
    id: t.id,
    claim: t.claim,
    reveal_line: t.revealLine,
    polarity: t.polarity,
    exhibits: t.exhibits,
    contrasts: t.contrasts,
    // Spec 2026-09-22 §5.4: typed title evidence, a separate id namespace from `exhibits`.
    exhibit_title_ids: (t.exhibitTitleIds as number[] | null) ?? [],
    contrast_title_ids: (t.contrastTitleIds as number[] | null) ?? [],
    inference_confidence: t.inferenceConfidence,
    status: t.status,
    user_note: t.userNote,
    user_weight: t.userWeight,
    verdict_updated_at: tsToIso(t.verdictUpdatedAt),
    created_at: tsToIso(t.createdAt),
  };
}
