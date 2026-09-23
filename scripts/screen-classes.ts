/**
 * Regenerates lib/server/screenClasses.json: every Wikidata class reachable through
 * P279* from film (Q11424), television program (Q15416) and television series
 * (Q5398426). One SPARQL walk per root. Needs network, so the controller runs it,
 * never a request:  npx tsx scripts/screen-classes.ts && npx prettier --write lib/server/screenClasses.json
 */
import { writeFileSync } from 'node:fs';

const USER_AGENT = 'ShelfSprite/0.1 (https://shelfsprite.app)';
const ROOTS = { film: 'Q11424', tv_program: 'Q15416', tv_series: 'Q5398426' } as const;

async function subclasses(root: string): Promise<string[]> {
  const query = `SELECT DISTINCT ?c WHERE { ?c wdt:P279* wd:${root} . }`;
  const resp = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/sparql-results+json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ query }).toString(),
  });
  if (!resp.ok) throw new Error(`WDQS answered ${resp.status} for ${root}`);
  const data = (await resp.json()) as {
    results: { bindings: Array<{ c: { value: string } }> };
  };
  const ids = data.results.bindings
    .map((b) => b.c.value.slice(b.c.value.lastIndexOf('/') + 1))
    .filter((id) => /^Q\d+$/.test(id));
  return [...new Set(ids)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

async function main(): Promise<void> {
  const out: Record<string, unknown> = {
    generated_at: new Date().toISOString().slice(0, 10),
    source: 'Wikidata P279* walk; regenerate with scripts/screen-classes.ts',
  };
  for (const [key, root] of Object.entries(ROOTS)) out[key] = await subclasses(root);
  writeFileSync('lib/server/screenClasses.json', `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    Object.keys(ROOTS)
      .map((key) => `${key}=${(out[key] as string[]).length}`)
      .join(' ')
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
