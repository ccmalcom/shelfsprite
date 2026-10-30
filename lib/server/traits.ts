import type { schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';
import { stripIdCitations, traitCitedIds } from '@/lib/server/traitText';

export type TraitRow = typeof schema.tasteTraits.$inferSelect;

/** Port of api.py's TraitOut serialization — trait row -> wire JSON. */
export function traitOut(t: TraitRow) {
  // The trait's own citations are the ids Claude might have echoed into its text.
  const cited = traitCitedIds(t);
  return {
    id: t.id,
    claim: stripIdCitations(t.claim, cited),
    reveal_line: t.revealLine === null ? null : stripIdCitations(t.revealLine, cited),
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
