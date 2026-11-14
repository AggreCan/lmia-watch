import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { freezeDeeply } from "../src/data";

// Production freezes a loaded file's top level only (src/data.ts); the tests
// freeze every node, so a page that changes a shared row in place throws here.
freezeDeeply(true);

// Split a SQL file into statements: drop comment lines, then cut on a
// semicolon that ends a line. Seed values never contain ";\n". A trigger's
// body holds statements of its own, so a CREATE TRIGGER runs on to the END
// that closes it (search_schema.sql keeps BEGIN and END on lines of their own
// statements).
export function splitSql(sql: string): string[] {
  const noComments = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const pieces = noComments
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: string[] = [];
  let trigger: string[] | null = null;
  for (const piece of pieces) {
    if (trigger) {
      trigger.push(piece);
      if (/^END$/i.test(piece)) {
        out.push(trigger.join(";\n"));
        trigger = null;
      }
    } else if (/^CREATE\s+TRIGGER\b/i.test(piece)) {
      trigger = [piece];
    } else {
      out.push(piece);
    }
  }
  if (trigger) throw new Error("a CREATE TRIGGER without its END");
  return out;
}

export async function applySql(db: D1Database, sql: string): Promise<void> {
  const statements = splitSql(sql);
  for (let i = 0; i < statements.length; i += 20) {
    await db.batch(statements.slice(i, i + 20).map((s) => db.prepare(s)));
  }
}

beforeAll(async () => {
  const e = env as unknown as { DB: D1Database; SEARCH: D1Database; SCHEMA_SQL: string; SEED_SQL: string; SEARCH_SCHEMA_SQL: string };
  await applySql(e.DB, e.SCHEMA_SQL);
  await applySql(e.DB, e.SEED_SQL);
  // The search database with its real indexes, full-text index and triggers;
  // test/search_api.test.ts fills it.
  await applySql(e.SEARCH, e.SEARCH_SCHEMA_SQL);
});
