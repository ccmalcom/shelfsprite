import { describe, it, expect } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../schema';

// Every table lives in Supabase's exposed `public` schema, so anyone holding the publishable key
// could read and write it through the Data API unless RLS is on. The app reaches Postgres only
// through DATABASE_URL as the table owner, which RLS does not restrict, so no policies are needed:
// RLS with zero policies denies the anon and authenticated roles outright.
describe('schema row-level security', () => {
  const tables = Object.values(schema).filter((v): v is PgTable => v instanceof PgTable);

  it('finds the tables', () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))('%s enables RLS', (_name, t) => {
    expect(getTableConfig(t).enableRLS).toBe(true);
  });
});
