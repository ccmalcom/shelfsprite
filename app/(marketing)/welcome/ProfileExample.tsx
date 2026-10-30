import ReaderSprite from '@/components/ReaderSprite';

/**
 * An example taste profile, drawn rather than screenshotted, in the shape of the real reader-type
 * card and trait rows (components/TasteHero.tsx, components/profile/TraitRow.tsx).
 *
 * It replaces a screenshot that had three problems on this page: the image lazy-loaded in below
 * the fold, the archetype panel it pictured took that reader's cool accent hue and sat off the
 * marketing palette, and the trait chips were cut off mid-sentence. This is a server component with
 * no state, so it is in the prerendered HTML; it uses only the shared palette tokens; and the chips
 * are short labels that never truncate. The one image is the reader-type sprite, whose space is
 * reserved by its fixed width and height.
 *
 * The fixture follows the example shelf at the top of the page. The archetype is a real one from
 * lib/server/archetype.ts (name and tagline copied exactly), chosen because its sprite is drawn at
 * the brand hue. The traits cite only books on that example shelf.
 */

const AXES = [
  { name: 'Lens', letter: 'I', label: 'Immersive', left: '18%', width: '32%' },
  { name: 'Engine', letter: 'P', label: 'Plot-first', left: '38%', width: '12%' },
  { name: 'Range', letter: 'B', label: 'Broad', left: '24%', width: '26%' },
  { name: 'Resonance', letter: 'H', label: 'Heart', left: '30%', width: '20%' },
];

const CHIPS = ['Narrators in the dark', 'Worlds as arguments', 'Endings that linger'];

const TRAITS = [
  {
    polarity: 'Loves',
    claim:
      'Narrators who understand less than you do. The gap between what they know and what you know is what keeps you reading.',
    evidence: 'Piranesi, Never Let Me Go',
    confidence: '91%',
  },
  {
    polarity: 'Loves',
    claim: 'Invented societies that work as arguments rather than scenery.',
    evidence: 'The Left Hand of Darkness',
    confidence: '84%',
  },
  {
    polarity: 'Avoids',
    claim: 'Nostalgia standing in for substance.',
    evidence: 'three books you rated two stars or lower',
    confidence: '78%',
  },
];

export default function ProfileExample() {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <p className="mb-4 font-mono text-xs uppercase tracking-widest text-muted">Reader type</p>
        <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:gap-8 sm:text-left">
          <div className="h-[120px] w-[120px] shrink-0 rounded-full bg-elevated p-3">
            <ReaderSprite code="IPBH" size={96} className="h-24 w-24" />
          </div>
          <div className="min-w-0">
            <span className="inline-flex items-center rounded-full bg-accent-quiet px-3 py-1 font-mono text-[1rem] font-medium text-accent">
              IPBH
            </span>
            <p className="mt-2 font-mono text-xs text-muted">
              {AXES.map((a, i) => (
                <span key={a.name}>
                  <span className="text-accent">{a.letter}</span> {a.label}
                  {i < AXES.length - 1 ? ' \u00b7 ' : ''}
                </span>
              ))}
            </p>
            <h3 className="mt-3 font-display text-3xl font-bold tracking-tight text-text">
              The Wandering Escapist
            </h3>
            <p className="mt-2 text-sm italic text-muted">Give me a new world every week.</p>
          </div>
        </div>

        <ul className="mt-6 flex flex-wrap gap-2" aria-label="Trait highlights">
          {CHIPS.map((chip) => (
            <li
              key={chip}
              className="inline-flex items-center rounded-full bg-elevated px-3 py-1 font-mono text-xs font-medium text-text"
            >
              {chip}
            </li>
          ))}
        </ul>

        <div className="mt-6 space-y-2.5" aria-hidden="true">
          {AXES.map((a) => (
            <div key={a.name} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted">{a.name}</span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-elevated">
                <div
                  className="absolute h-2 rounded-full bg-accent"
                  style={{ left: a.left, width: a.width }}
                />
              </div>
              <span className="w-28 shrink-0 text-xs text-text">
                <span className="font-mono font-semibold text-accent">{a.letter}</span> {a.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <ul className="space-y-3">
        {TRAITS.map((t) => {
          const loves = t.polarity === 'Loves';
          return (
            <li
              key={t.claim}
              className={[
                'flex gap-4 rounded-xl border bg-surface p-4',
                loves ? 'border-success/30' : 'border-danger/30',
              ].join(' ')}
            >
              <span
                className={[
                  'inline-flex h-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
                  loves ? 'bg-success-quiet text-success' : 'bg-danger-quiet text-danger',
                ].join(' ')}
              >
                {t.polarity}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-text">{t.claim}</p>
                <p className="mt-1 text-xs text-faint">From {t.evidence}</p>
              </div>
              <span className="shrink-0 font-mono text-xs text-faint">{t.confidence}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
