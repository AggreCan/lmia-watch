// Times what an employer page costs the Worker, part by part, on real
// profiles: parsing and freezing the data files the page reads, rendering the
// page, and hashing the body for its ETag. Run from site/:
//
//   node scripts/bench-render.mjs            (the timings)
//   node scripts/bench-render.mjs --profile  (also a CPU profile of 300 renders)
//   node scripts/bench-render.mjs --src <dir> --json
//     (the source tree under <dir>, such as a checkout of an older commit's
//     site/, and one line of JSON with the summary, for an A/B comparison
//     run in alternation, which keeps a busy machine from deciding it)
//
// The data are copies of the live files under test/fixtures/bench/ (profile
// shards, stats.json, the occupation and directory indexes, and the place and
// area files of the profiles below); fetch them again from
// https://lmiawatch.ca/data/<path> to bench newer data. The source is bundled
// with esbuild and run in Node, whose V8 is the engine the Worker runs on:
// inside workerd the clock stands still while code runs, so a benchmark there
// cannot time itself. No D1, rate limiter, page cache or analytics binding is
// given, so the page renders as it would on a cache miss with no responses or
// corrections, and nothing is counted.

import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { Session } from "node:inspector/promises";

const SITE = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const BENCH = join(SITE, "test", "fixtures", "bench");
// Four large profiles, plus the busiest one in their shards (127 list rows).
const PROFILES = ["emp-e11aad356c", "emp-86dcd8499d", "emp-70f6c710a9", "emp-7fde18dbff", "emp-70ff73aa39"];
const RUNS = 60;
const profile = process.argv.includes("--profile");
const json = process.argv.includes("--json");
const srcAt = process.argv.indexOf("--src");
const SRC = srcAt > 0 ? process.argv[srcAt + 1] : SITE;
const summary = {};
const log = (...args) => { if (!json) console.log(...args); };

const out = mkdtempSync(join(tmpdir(), "lmia-bench-"));
const entry = [
  'export { app } from "./src/index.tsx";',
  'export { clearParsedCache, loadJson } from "./src/data.ts";',
  'export { bodyEtag } from "./src/conditional.ts";',
].join("\n");
await build({
  stdin: { contents: entry, resolveDir: SRC, loader: "ts" },
  nodePaths: [join(SITE, "node_modules")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: join(out, "bench.mjs"),
  tsconfig: join(SITE, "tsconfig.json"),
  logLevel: "warning",
});
const mod = await import(pathToFileURL(join(out, "bench.mjs")).href);
rmSync(out, { recursive: true, force: true });

// Every file under the bench folder, by its path under /data/, with an ETag
// from its content as the assets binding sends one.
const files = new Map();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith(".json")) files.set(relative(BENCH, p).replaceAll("\\", "/"), readFileSync(p, "utf8"));
  }
};
walk(BENCH);
const etags = new Map([...files].map(([p, text], i) => [p, `"bench-${i}-${text.length}"`]));
const ASSETS = {
  fetch: async (input) => {
    const path = new URL(typeof input === "string" ? input : input.url).pathname.replace(/^\/data\//, "");
    const text = files.get(path);
    if (text === undefined) return new Response("not found", { status: 404 });
    return new Response(text, { headers: { "content-type": "application/json", etag: etags.get(path) } });
  },
};
const env = { ASSETS };

const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
async function time(fn, runs = RUNS) {
  for (let i = 0; i < 5; i++) await fn(); // warm the JIT
  const t = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  return median(t);
}
const ms = (v) => `${v.toFixed(3)} ms`;

log("1. parse and freeze, per file (loadJson with an empty parsed cache: fetch, text, JSON.parse, freeze)");
const bigFiles = [...files.keys()].filter((p) => (files.get(p)?.length ?? 0) > 20_000).sort();
for (const path of bigFiles) {
  const text = files.get(path);
  const parse = await time(() => JSON.parse(text));
  const load = await time(async () => {
    mod.clearParsedCache();
    await mod.loadJson(env, path);
  });
  // The same call for a tiny file: what the fetch and the cache bookkeeping cost alone.
  summary[`parse ${path}`] = parse;
  summary[`load ${path}`] = load;
  log(`   ${path.padEnd(24)} ${String(text.length).padStart(7)} chars  JSON.parse ${ms(parse)}  loadJson ${ms(load)}`);
}
const tiny = await time(async () => {
  mod.clearParsedCache();
  await mod.loadJson(env, "directory/index.json");
});
log(`   directory/index.json (${files.get("directory/index.json").length} chars, the fetch overhead): loadJson ${ms(tiny)}`);

log("2. render (warm parsed cache) and 3. ETag hash of the body");
const request = (id, lang) => mod.app.request(`/employers/${id}`, { headers: lang === "fr" ? { cookie: "lang=fr" } : {} }, env);
let total = { render: 0, etag: 0, n: 0 };
for (const id of PROFILES) {
  for (const lang of ["en", "fr"]) {
    const res = await request(id, lang);
    if (res.status !== 200) throw new Error(`${id} ${lang}: ${res.status}`);
    const body = await res.arrayBuffer();
    // The request includes the ETag hash (conditional.ts); the hash is timed
    // on its own and taken off, which leaves the render and the middleware.
    const full = await time(async () => (await request(id, lang)).arrayBuffer());
    const etag = await time(() => mod.bodyEtag(body));
    total.render += full - etag;
    total.etag += etag;
    total.n++;
    log(`   ${id} ${lang}  ${String(body.byteLength).padStart(7)} B  request ${ms(full)}  of which ETag ${ms(etag)}  render ${ms(full - etag)}`);
  }
}
summary.render = total.render / total.n;
summary.etag = total.etag / total.n;
log(`   mean render ${ms(summary.render)}, mean ETag ${ms(summary.etag)}`);

const cold = await time(async () => {
  mod.clearParsedCache();
  for (const id of PROFILES) await (await request(id, "en")).arrayBuffer();
}, 30);
summary.cold = cold / PROFILES.length;
log(`4. a request with nothing parsed yet (as on a new isolate), mean of the five profiles: ${ms(cold / PROFILES.length)}`);

// 5. The page cache (src/pagecache.ts): a miss (render, hash, store) against
// a hit, with an in-memory stand-in for the Cache API and an execution
// context, as in production. The forms database is absent, so a profile's
// forms digest is "0" without a query.
const store = new Map();
globalThis.caches = {
  open: async () => ({
    match: async (key) => {
      const e = store.get(typeof key === "string" ? key : key.url);
      return e ? new Response(e.body, { status: e.status, headers: e.headers }) : undefined;
    },
    put: async (key, res) => {
      store.set(typeof key === "string" ? key : key.url, { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] });
    },
  }),
};
const ctxEnv = { ...env, CF_VERSION_METADATA: { id: "bench", tag: "" } };
const viaCache = async (id) => {
  const waits = [];
  const res = await mod.app.request(`/employers/${id}`, {}, ctxEnv, { waitUntil: (p) => waits.push(p), passThroughOnException: () => {} });
  await res.arrayBuffer();
  await Promise.all(waits);
  return res.headers.get("x-page-cache");
};
if ((await viaCache(PROFILES[0])) === null) {
  log("5. no page cache in this source tree");
} else {
  const miss = await time(async () => {
    store.clear();
    for (const id of PROFILES) if ((await viaCache(id)) !== "miss") throw new Error("expected a miss");
  });
  const hit = await time(async () => {
    for (const id of PROFILES) if ((await viaCache(id)) !== "hit") throw new Error("expected a hit");
  });
  summary.miss = miss / PROFILES.length;
  summary.hit = hit / PROFILES.length;
  log(`5. page cache, mean of the five profiles: miss (render and store) ${ms(summary.miss)}, hit ${ms(summary.hit)}`);
}
delete globalThis.caches;

if (profile) {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.setSamplingInterval", { interval: 50 });
  await session.post("Profiler.start");
  for (let i = 0; i < 30; i++) for (const id of PROFILES) for (const lang of ["en", "fr"]) await (await request(id, lang)).arrayBuffer();
  const { profile: p } = await session.post("Profiler.stop");
  const file = join(tmpdir(), "lmia-render.cpuprofile");
  writeFileSync(file, JSON.stringify(p));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  p.samples.forEach((s, i) => {
    const f = byId.get(s).callFrame;
    const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
  });
  console.log(`profile written to ${file}; self time over 300 renders:`);
  for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`   ${v.toFixed(1).padStart(7)} ms  ${k}`);
}
if (json) console.log(JSON.stringify(summary));
