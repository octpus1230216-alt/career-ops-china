#!/usr/bin/env node
/**
 * cn_bridge.mjs — Chinese job-source orchestrator (PRODUCER).
 *
 * Runs the two external CLI sources declared under `cn_sources` in portals.yml,
 * merges them into a single de-duplicated cache that the read-only
 * `cn_cache_reader.mjs` (a local-parser provider) feeds to scan.mjs:
 *
 *   1. Hiring-Radar  -> the SOLE full-volume entry  (python3 hiring_radar.py --local --json)
 *   2. job-pro       -> fills the COMPANY-LEVEL DIFF only (companies HR doesn't cover)
 *
 * Guarantees baked in (per the integration spec):
 *   - Companies already tracked natively in `tracked_companies` are EXCLUDED
 *     (auto-derived by scanning tracked_companies + the explicit exclude_companies
 *     list, all normalized through `company_aliases`). No double-fetch.
 *   - Every row lands in the cache and is de-duplicated by the unique key
 *     `{company}|{title_norm}|{location_norm}`, resolving collisions with the
 *     `prefer: [native, job-pro, hiring-radar, websearch]` source order.
 *
 * This script is the ONLY place the heavy CLIs run. scan.mjs never execs them
 * (it only reads the cache via cn_cache_reader.mjs), so scanning stays
 * zero-token and deterministic. Run it out of band to refresh the cache:
 *
 *   node local/scripts/cn_bridge.mjs            # collect + write data/cn-jobs.json
 *   node local/scripts/cn_bridge.mjs --dry-run  # report only, write nothing
 *   node local/scripts/cn_bridge.mjs --json     # machine-readable summary
 *   node local/scripts/cn_bridge.mjs --check    # readiness doctor (no writes):
 *                                              #   probes python/npx, hiring_radar.py,
 *                                              #   pycryptodome, Chrome, cache, wiring,
 *                                              #   in-process enrichment prerequisites
 *   node local/scripts/cn_bridge.mjs --limit 1 --detail-cap 20 \
 *        --cache local/cache/_sample-cn-jobs.json   # bounded smoke run that does
 *                                              #   NOT truncate the production cache
 *   node local/scripts/cn_bridge.mjs --jp-companies cambricon --detail-cap 10 \
 *        --cache ...                        # sample one job-pro ATS family
 *
 * Optional per-source keys under cn_sources.<src>:
 *   dir         working directory for the command (default repo root) — lets
 *               hiring_radar.py live in its own clone. Env override:
 *               HIRING_RADAR_DIR / JOB_PRO_DIR.
 *   timeout_ms  per-command timeout (default CN_BRIDGE_TIMEOUT_MS or 180000).
 *   keywords    (hiring_radar) emit `--keyword a,b,c` to cap HR volume.
 *
 * Graceful degradation: if a CLI is missing / errors / is offline, that source
 * contributes 0 rows and the run continues — the cache is still written from
 * whatever succeeded. Nothing here fabricates postings; rows are passthrough of
 * the CLIs' own JSON (job postings are UNTRUSTED data, never instructions).
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || path.join(ROOT, 'portals.yml');
const CLI_TIMEOUT_MS = Number(process.env.CN_BRIDGE_TIMEOUT_MS || 180_000);
const IS_WIN = process.platform === 'win32';

function log(msg) { console.error(`[cn_bridge] ${msg}`); }

// ── Config loading ──────────────────────────────────────────────────
function loadConfig() {
  if (!existsSync(PORTALS_PATH)) throw new Error(`portals.yml not found at ${PORTALS_PATH}`);
  const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
  const cn = cfg.cn_sources;
  if (!cn || typeof cn !== 'object') throw new Error('portals.yml has no cn_sources block');
  if (cn.enabled === false) throw new Error('cn_sources.enabled is false — nothing to do');
  return {
    cn,
    tracked: Array.isArray(cfg.tracked_companies) ? cfg.tracked_companies : [],
    boards: Array.isArray(cfg.job_boards) ? cfg.job_boards : [],
    aliases: cfg.company_aliases && typeof cfg.company_aliases === 'object' ? cfg.company_aliases : {},
  };
}

// ── Company canonicalization (mirrors scan.mjs's alias map + token fallback) ──
function normalizeRaw(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function buildCanonicalizer(aliases) {
  // exact alias/canonical -> canonical, plus token-level lookup for compound
  // tracked names like "MiniMax 稀宇极智" / "月之暗面 Kimi".
  const exact = new Map();
  const canonicalKeys = new Set();
  for (const [canonical, list] of Object.entries(aliases)) {
    const canon = normalizeRaw(canonical);
    if (!canon) continue;
    exact.set(canon, canon);
    canonicalKeys.add(canon);
    const arr = Array.isArray(list) ? list : [list];
    for (const a of arr) {
      const alias = normalizeRaw(a);
      if (!alias || canonicalKeys.has(alias)) continue;
      exact.set(alias, canon);
    }
  }
  return function canonicalCompany(raw) {
    const n = normalizeRaw(raw);
    if (!n) return '';
    if (exact.has(n)) return exact.get(n);
    // token fallback: any recognizable alias inside a compound name wins
    for (const tok of n.split(/[\s ()（）/、,，]+/).filter(Boolean)) {
      if (exact.has(tok)) return exact.get(tok);
    }
    return n;
  };
}

// Display label (canonical key -> a readable name from the alias map) so the
// cache/pipeline shows "ByteDance" not "字节跳动"/"bytedance".
function buildDisplayMap(aliases) {
  const map = new Map();
  for (const canonical of Object.keys(aliases || {})) {
    map.set(normalizeRaw(canonical), canonical);
  }
  return function displayFor(canonKey) {
    return map.get(canonKey) || canonKey;
  };
}

// ── Exclusion set: tracked_companies (native) ∪ explicit exclude_companies ──
export function buildExcludeSet({ cn, tracked }, canonicalCompany) {
  const set = new Set();
  for (const entry of tracked) {
    if (!entry || typeof entry.name !== 'string') continue;
    const c = canonicalCompany(entry.name);
    if (c) set.add(c);
  }
  for (const name of Array.isArray(cn.exclude_companies) ? cn.exclude_companies : []) {
    const c = canonicalCompany(name);
    if (c) set.add(c);
  }
  return set;
}

// ── Process runner (no shell; argv arrays; graceful degrade) ─────────
function resolveExe(base) {
  if (!IS_WIN) return base;
  if (base === 'npx') return 'npx.cmd';
  if (base === 'python3') return 'python'; // python3 shim absent on many Windows setups
  return base;
}

// Windows ships npm/npx/pnpm/yarn as `.cmd` shims, which spawnSync cannot exec
// directly with shell:false (it throws EINVAL). Route those through cmd.exe's
// `/d /c` (still no shell string interpolation: the executable and every arg
// stay separate argv entries; /d disables the profile's autorun).
function isWindowsBatch(exe) {
  return /\.(cmd|bat)$/i.test(exe);
}

function splitCommand(cmdStr) {
  // The configured base commands have no quoted args with spaces, so a simple
  // whitespace split is sufficient and safe (we pass argv without a shell).
  return String(cmdStr).trim().split(/\s+/).filter(Boolean);
}

// Resolve a source's working directory: an explicit `dir` in cn_sources.<src>
// (or the matching env override) beats the repo-root default. This is what lets
// hiring_radar.py live in its own clone instead of being copied to the repo root.
function resolveSourceDir(sourceCfg, envName) {
  const env = process.env[envName]?.trim();
  const raw = env || sourceCfg?.dir;
  if (!raw) return ROOT;
  return path.resolve(ROOT, String(raw));
}

function runCli(cmdStr, extraArgs = [], opts = {}) {
  const argv = splitCommand(cmdStr);
  if (argv.length === 0) return { ok: false, stdout: '', error: 'empty command' };
  const command = resolveExe(argv[0]);
  const args = [...argv.slice(1), ...extraArgs];
  const batch = IS_WIN && isWindowsBatch(command);
  const file = batch ? 'cmd.exe' : command;
  const spawnArgs = batch ? ['/d', '/c', command, ...args] : args;
  try {
    const res = spawnSync(file, spawnArgs, {
      cwd: opts.cwd || ROOT,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeoutMs || CLI_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      // Force UTF-8 stdio for any Python we (or hiring_radar's child parsers)
      // spawn. On Windows the default console codepage (cp936) can't encode
      // some CJK/emoji, so a parser's `print(json.dumps(..., ensure_ascii=False))`
      // raises UnicodeEncodeError and the whole key fails. These vars make the
      // child streams UTF-8 regardless of console locale; harmless to npx.
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    if (res.error) {
      return { ok: false, stdout: '', error: `${file} ${spawnArgs.join(' ')}: ${res.error.message}` };
    }
    if (res.status !== 0) {
      const stderr = (res.stderr || '').trim().split('\n').slice(0, 3).join(' | ');
      return { ok: false, stdout: res.stdout || '', error: `exit ${res.status}: ${stderr || '(no stderr)'}` };
    }
    return { ok: true, stdout: res.stdout || '', error: null };
  } catch (err) {
    return { ok: false, stdout: '', error: err.message };
  }
}

// Pull the first JSON value ([...] or {...}) out of stdout that may carry
// install / progress noise (esp. npx).
function extractJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const arrS = text.indexOf('['), objS = text.indexOf('{');
  const starts = [arrS, objS].filter(i => i >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const closer = text[start] === '[' ? ']' : '}';
  const end = text.lastIndexOf(closer);
  if (end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── Row normalization ───────────────────────────────────────────────
function coerceUrl(row) {
  const raw = String(row.url || row.apply_url || row.applyUrl || row.jobUrl || '').trim();
  return raw;
}

function coerceLocation(row) {
  const v = row.location ?? row.locations ?? row.location_names ?? row.work_cities ?? row.city ?? '';
  return v;
}

function coercePostedAt(row) {
  for (const k of ['date', 'postedAt', 'posted_at', 'date_updated', 'updated_at', 'published_at']) {
    const val = row[k];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) return val;
    if (typeof val === 'string' && val) {
      const ms = Date.parse(val);
      if (!Number.isNaN(ms) && ms > 0) return ms;
    }
  }
  return undefined;
}

/**
 * Turn one raw CLI posting into a cache row (or null if unusable).
 * @param {any} row
 * @param {string} source
 * @param {(raw: string) => string} canonicalCompany
 * @param {(canon: string) => string} displayFor
 */
export function toCacheRow(row, source, canonicalCompany, displayFor, fallbackCompany) {
  if (!row || typeof row !== 'object') return null;
  const title = String(row.title || row.name || '').trim();
  const url = coerceUrl(row);
  if (!title || !url) return null;
  // job-pro postings carry no company (it's implied by the queried slug), so
  // fall back to the caller-provided target name; Hiring-Radar rows carry it.
  const canon = canonicalCompany(row.company || row.org || row.org_name || fallbackCompany || '');
  const rec = {
    title,
    url,
    company: displayFor(canon),
    company_norm: canon,
    location: coerceLocation(row),
    source,
  };
  const desc = row.jd || row.description || '';
  if (typeof desc === 'string' && desc.trim()) rec.description = desc;
  const postedAt = coercePostedAt(row);
  if (postedAt !== undefined) rec.postedAt = postedAt;
  // Light passthrough metadata for provenance / downstream precision.
  for (const k of ['req_id', 'dept', 'team', 'remote', 'type', 'comp']) {
    if (row[k] != null && row[k] !== '') rec[k] = row[k];
  }
  return rec;
}

function parseRows(stdout, source, canonicalCompany, displayFor, fallbackCompany) {
  const json = extractJson(stdout);
  // Each CLI wraps its array under a different key: hiring-radar -> jobs,
  // job-pro -> positions; older/other shapes use results/data/items/offers.
  const arrCandidates = [json, json?.jobs, json?.positions, json?.results, json?.data, json?.items, json?.offers];
  const arr = arrCandidates.find(Array.isArray) ?? null;
  if (!arr) return { rows: [], note: 'no JSON array' };
  const rows = [];
  for (const r of arr) {
    const row = toCacheRow(r, source, canonicalCompany, displayFor, fallbackCompany);
    if (row) rows.push(row);
  }
  return { rows, note: null };
}

// ── Source 1: Hiring-Radar (full volume) ────────────────────────────
// The real CLI has no single "all" command: `--local <key>` runs ONE parser,
// and the Chinese universe is the `--local：N` section of `hiring_radar.py --list`
// (170 keys, seeded from parsers/companies.seed). So "full volume" = enumerate
// those keys and query each one. Per-key failures are tolerated (a Moka board
// without pycryptodome, a slow/blocked site) — the source contributes whatever
// succeeded and the run continues.
function parseLocalKeys(listStdout) {
  // Find the "--local：<N>" header line, then read the following (single) line of
  // space-separated keys until the next blank/section line.
  const lines = String(listStdout || '').split(/\r?\n/);
  const hdr = lines.findIndex(l => /--local[：:]\s*\d+/.test(l));
  if (hdr === -1) return [];
  for (let i = hdr + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('==')) break; // next section, key line was blank
    return line.split(/\s+/).filter(Boolean);
  }
  return [];
}

export function selectHrKeys(allKeys, companiesCfg) {
  if (Array.isArray(companiesCfg) && companiesCfg.length) {
    const want = new Set(companiesCfg.map(k => String(k).toLowerCase().trim()));
    return allKeys.filter(k => want.has(k.toLowerCase().trim()));
  }
  return allKeys; // 'all' / unset
}

function runHiringRadar(hiringRadar, canonicalCompany, displayFor) {
  const command = hiringRadar?.command;
  if (!command) return { rows: [], companies: new Set(), skipped: 'no command configured', meta: null };
  const cwd = resolveSourceDir(hiringRadar, 'HIRING_RADAR_DIR');
  const timeoutMs = Number(hiringRadar.timeout_ms) || CLI_TIMEOUT_MS;
  const perKeyMs = Number(hiringRadar.per_company_timeout_ms) || 60_000;
  const limit = Number(hiringRadar.limit) || 0; // 0 = no cap (full volume)
  // Optional keyword bound: HR accepts `--keyword a,b,c` (comma OR) server- and
  // post-filter. Set cn_sources.hiring_radar.keywords to cut volume across 170
  // parsers; omit to fetch everything and let scan.mjs's filters do precision.
  const kw = Array.isArray(hiringRadar.keywords) && hiringRadar.keywords.length
    ? ['--keyword', hiringRadar.keywords.join(',')] : [];

  // 1) Discover the local parser keys (offline, fast).
  const listRes = runCli(command, ['--list'], { cwd, timeoutMs });
  if (!listRes.ok) {
    log(`Hiring-Radar --list unavailable: ${listRes.error} — contributing 0 rows`);
    return { rows: [], companies: new Set(), skipped: listRes.error, meta: null };
  }
  let keys = selectHrKeys(parseLocalKeys(listRes.stdout), hiringRadar.companies);
  const total = keys.length;
  if (limit > 0) keys = keys.slice(0, limit);
  log(`Hiring-Radar: ${total} local parser key(s) discovered, querying ${keys.length} (kw: ${kw.join(' ') || 'none'})`);

  // 2) Query each key; tolerate per-key failure.
  const rows = [];
  const failures = [];
  let empty = 0;
  for (const key of keys) {
    const res = runCli(command, ['--local', key, '--json', ...kw], { cwd, timeoutMs: perKeyMs });
    if (!res.ok) { failures.push(`${key}: ${res.error}`); continue; }
    const parsed = parseRows(res.stdout, 'hiring-radar', canonicalCompany, displayFor);
    if (parsed.rows.length === 0) empty++;
    for (const r of parsed.rows) rows.push(r);
  }
  const companies = new Set();
  for (const r of rows) if (r.company_norm) companies.add(r.company_norm);
  if (failures.length) log(`Hiring-Radar: ${failures.length} key(s) errored, e.g. ${failures.slice(0, 3).join(' ; ')}`);
  log(`Hiring-Radar: ${rows.length} row(s), ${companies.size} company(ies) with postings, ${empty} empty`);
  return { rows, companies, skipped: null, meta: { keys_discovered: total, keys_queried: keys.length, errored: failures.length, empty } };
}

// ── Source 2: job-pro (company-level diff) ──────────────────────────
// job-pro's `search --compact` is metadata-only (post_id/title/work_cities/
// apply_url, no JD body). The CLI ships a `detail <post_id>` verb that returns
// the full JD (description + requirements + recruit_label + work_cities). We do
// NOT call that verb per row (measured ~2.8s per npx spawn — process startup,
// not network); instead one batched child process per company runs the same
// fetch in-process via enrich-details.mjs. Design guarantees:
//   - post_id comes from the search row; if absent it's recovered from the
//     apply_url (feishu /position/<digits>/detail, moka #/job/<uuid>, …) — which
//     is the SAME id the detail verb resolves (verified live).
//   - A detail failure NEVER drops the row: it lands exactly as before (title +
//     url + company + location metadata). Enrichment is additive.
//   - stdout stays clean (log() is stderr); enrichment knobs live in
//     cn_sources.job_pro: fetch_details (default on) / detail_limit /
//     detail_concurrency / moka_concurrency / slow_families / detail_jitter_ms /
//     jd_max_age_days / detail_retries / checkpoint_every / detail_timeout_ms /
//     enrich_timeout_ms / enrich_script / package_root / enrich_store_dir.
const URL_ID_RE = /(?:\/position\/|#\/job\/)(\d{6,}|[0-9a-f]{8}-[0-9a-f-]{20,})/i;

function extractPostId(row) {
  const direct = String(row.post_id ?? row.id ?? row.job_id ?? '').trim();
  if (direct) return direct;
  const m = coerceUrl(row).match(URL_ID_RE);
  return m ? m[1] : '';
}

// detail output is defensive: shape confirmed for the Feishu family
// ({ok, description, requirements, …}); other adapters are checked for the
// common keys before anything is trusted. recruit_label often carries the
// channel (社招/校招) the search page didn't show.
function detailBody(json) {
  if (!json || typeof json !== 'object') return null;
  return json.description || json.jd || json.detail?.description || json.position?.description || null;
}

function buildDetailText(d) {
  const clean = (v) => String(v || '').replace(/<[^>]*>/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const desc = clean(d.description);
  const req = clean(d.requirements || d.requirement);
  if (!desc && !req) return '';
  const parts = [];
  if (desc) parts.push(`【岗位职责】\n${desc}`);
  if (req) parts.push(`【任职要求】\n${req}`);
  return parts.join('\n\n');
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── In-process enrichment (approach B: ONE child process per company) ──
// job-pro's `detail` verb costs ~2.8s per call under npx — that is process
// spawn, not network — so the old per-row loop (37 companies x up to 150 rows)
// extrapolated to hours. enrich-details.mjs imports dist/<slug>.js once and
// calls fetchPositionDetail directly (measured 89-111ms/item at concurrency
// 2-5), turning thousands of spawns into ~dozens: one child per company, which
// also keeps this file's synchronous runCli style intact.
const JP_FAMILIES = ['moka', 'feishu', 'wecruit', 'liepin', 'greenhouse', 'lever'];

function resolveEnrichConfig(jobPro) {
  const script = path.resolve(ROOT, jobPro.enrich_script || 'local/scripts/enrich-details.mjs');
  const pkgRoot = path.resolve(ROOT, jobPro.package_root || 'local/node_modules/@ha7ch/job-pro');
  if (!existsSync(script)) return { available: false, reason: `enrich script missing: ${script}` };
  if (!existsSync(path.join(pkgRoot, 'dist'))) {
    return { available: false, reason: `@ha7ch/job-pro not installed at ${pkgRoot} (npm install --prefix local @ha7ch/job-pro@1.2.1)` };
  }
  const clampConc = (v, def) => Math.max(1, Math.min(8, Number(v) || def));
  return {
    available: true,
    script,
    pkgRoot,
    storeDir: path.resolve(ROOT, jobPro.enrich_store_dir || 'local/cache'),
    concurrency: clampConc(jobPro.detail_concurrency, 3),
    mokaConcurrency: clampConc(jobPro.moka_concurrency, 2),
    slowFamilies: Array.isArray(jobPro.slow_families) && jobPro.slow_families.length
      ? jobPro.slow_families.map(String)
      : ['moka'],                       // SSR+AES adapters measured ~700ms/item
    jitter: Math.max(0, Number(jobPro.detail_jitter_ms ?? 200)),
    maxAgeDays: Number.isFinite(Number(jobPro.jd_max_age_days)) ? Number(jobPro.jd_max_age_days) : 14,
    retries: Math.max(0, Number(jobPro.detail_retries ?? 2)),
    checkpointEvery: Math.max(1, Number(jobPro.checkpoint_every ?? 20)),
    perItemTimeoutMs: Math.max(1000, Number(jobPro.detail_timeout_ms) || 30_000),
    batchTimeoutMs: Math.max(60_000, Number(jobPro.enrich_timeout_ms) || 900_000),
  };
}

// Which family adapter a company module delegates to — read only, we never
// write inside node_modules. The family decides the concurrency cap, because
// measured latency differs by ~8x between them.
function detectJpFamily(pkgRoot, slug) {
  const file = path.join(pkgRoot, 'dist', `${slug}.js`);
  if (!existsSync(file)) return null;
  try {
    const src = readFileSync(file, 'utf8');
    const imported = [...src.matchAll(/from\s+['"]\.\/([A-Za-z0-9_-]+)\.js['"]/g)].map(m => m[1]);
    for (const fam of JP_FAMILIES) if (imported.includes(fam)) return fam;
    return 'direct';
  } catch {
    return null;
  }
}

// Survivor test BEFORE spending a fetch. Keywords used to be only an upstream
// `search` argument, so every returned row got enriched — including rows a
// title filter would have dropped anyway.
function survivorByTitle(row, keywords) {
  if (!Array.isArray(keywords) || !keywords.length) return true;
  const hay = String(row.title || '').toLowerCase();
  return keywords.some(k => { const s = String(k || '').trim().toLowerCase(); return s && hay.includes(s); });
}

// One child process for one company. Returns the enriched records keyed by
// post_id, plus plan/execution stats and the classified failure list.
function enrichCompanyViaChild({ slug, items, cfg, priorRows, dryRun = false }) {
  mkdirSync(cfg.storeDir, { recursive: true });
  const store = path.join(cfg.storeDir, `jobpro-enriched-${slug}.json`);
  const inFile = path.join(cfg.storeDir, `${dryRun ? '_dry-' : '_in-'}${slug}.json`);

  // Seed the resume store from the existing cache so a deleted store does not
  // mean "refetch everything": only rows that carry BOTH a body and the
  // timestamp we wrote next to it count as fresh (same rule as the child's).
  // A dry run never seeds — it must not create files.
  if (!dryRun && !existsSync(store) && priorRows.length) {
    const urlMap = new Map(priorRows.filter(r => r && r.url).map(r => [r.url, r]));
    const seeded = [];
    for (const it of items) {
      const old = urlMap.get(it.row.url);
      if (old && String(old.description || '').trim() && old.jd_fetched_at) {
        seeded.push({ post_id: it.pid, title: it.row.title, apply_url: it.row.url, description: old.description, fetched_at: old.jd_fetched_at });
      }
    }
    if (seeded.length) {
      writeFileSync(store, JSON.stringify({ company: slug, seeded_from_cache: true, positions: seeded }, null, 2), 'utf8');
      log(`job-pro/${slug}: seeded ${seeded.length} record(s) into the resume store from cache`);
    }
  }

  writeFileSync(inFile, JSON.stringify(items.map(it => ({ post_id: it.pid, title: it.row.title, apply_url: it.row.url }))), 'utf8');

  const family = detectJpFamily(cfg.pkgRoot, slug);
  const slow = family && cfg.slowFamilies.includes(family);
  const concurrency = slow ? cfg.mokaConcurrency : cfg.concurrency;
  const args = [
    cfg.script,
    '--input', inFile,
    '--company', slug,
    '--output', store,
    '--package-root', cfg.pkgRoot,
    '--concurrency', String(concurrency),
    '--jitter', String(cfg.jitter),
    '--max-age-days', String(cfg.maxAgeDays),
    '--retries', String(cfg.retries),
    '--checkpoint-every', String(cfg.checkpointEvery),
    '--timeout-ms', String(cfg.perItemTimeoutMs),
  ];
  // Dry run hands --dry-run to the child so the skip/fetch plan comes from the
  // SAME freshness code a real run uses, instead of a second copy here.
  if (dryRun) args.push('--dry-run');
  const res = runCli('node', args, { cwd: ROOT, timeoutMs: cfg.batchTimeoutMs });

  const byId = new Map();
  let stats = { total: items.length, skip: 0, fetch: 0, ok: 0, failed: 0, wall_ms: 0 };
  let plan = null;
  let salvaged = 0;

  // The child checkpoints with tmp + renameSync, so whatever is on disk is a
  // complete snapshot — reading it is safe even when the child died mid-run.
  const readStore = () => {
    let snap;
    try { snap = JSON.parse(readFileSync(store, 'utf8')); }
    catch (e) { log(`job-pro/${slug}: store unreadable (${e.message}) — rows kept metadata-only`); return null; }
    for (const rec of (snap && snap.positions) || []) {
      const pid = String(rec.post_id || '').trim();
      if (pid) byId.set(pid, rec);
    }
    return snap;
  };

  if (res.ok) {
    const lines = String(res.stdout || '').split('\n');
    const planLine = lines.find(l => l.startsWith('[plan] '));
    if (planLine) {
      const g = (k) => Number((planLine.match(new RegExp(`${k}=(\\d+)`)) || [])[1] ?? 0);
      plan = { total: g('total'), skip: g('skip'), fetch: g('fetch'), concurrency: g('concurrency') };
    }
    if (dryRun) {
      if (plan) { stats = { total: plan.total, skip: plan.skip, fetch: plan.fetch, ok: 0, failed: 0, wall_ms: 0 }; }
    } else {
      const doneLine = lines.find(l => l.startsWith('[done] '));
      if (doneLine) {
        const g = (k) => Number((doneLine.match(new RegExp(`${k}=(\\d+)`)) || [])[1] ?? 0);
        const w = Number(((doneLine.match(/wall=([\d.]+)s/) || [])[1] ?? 0)) * 1000;
        stats = { total: items.length, skip: g('skipped'), fetch: g('fetched'), ok: g('ok'), failed: g('failed'), wall_ms: Math.round(w) };
      }
    }
    if (!dryRun) readStore();
  } else if (!dryRun) {
    // Priority-4 salvage: a killed or timed-out child still leaves every body it
    // had already checkpointed. Harvest them rather than reporting a productive
    // run as "0 enriched", and rebuild the counters from the snapshot's own
    // fields. Whatever is missing stays in the store for the next run to resume.
    const snap = readStore();
    const withBody = [...byId.values()].filter(r => detailBody(r)).length;
    if (snap && byId.size) {
      const totalRec = Number(snap.total) || byId.size;
      const skipped = Number(snap.skipped) || 0;
      salvaged = withBody;
      stats = {
        total: items.length,
        skip: skipped,
        fetch: Math.max(0, totalRec - skipped),
        ok: withBody,
        // Rows we got nothing for are counted once, by the caller, as detail
        // misses; only the child's own recorded failures add to this.
        failed: Number(snap.failed) || 0,
        wall_ms: 0,
        aborted: true,
      };
      log(`job-pro/${slug}: enrichment child aborted (${res.error}) — salvaged ${withBody} record(s) from the checkpoint store, ${Math.max(0, items.length - byId.size)} left to resume next run`);
    }
  }

  // Failure isolation: the child writes <store>.failures.json classified by
  // kind. We surface counts and keep them in the summary instead of swallowing.
  const failFile = `${store}.failures.json`;
  let failures = [];
  if (existsSync(failFile)) {
    try {
      const fj = JSON.parse(readFileSync(failFile, 'utf8'));
      failures = Array.isArray(fj.failures) ? fj.failures : [];
    } catch { /* keep empty; the file stays as evidence */ }
  }
  try { unlinkSync(inFile); } catch { /* best effort */ }

  return { ok: res.ok, error: res.error, family, slow, concurrency, byId, plan, stats, failures, salvaged };
}

function listJobProCompanies(jobPro, runOpts) {
  const res = runCli(jobPro.command, ['list', '--compact'], runOpts);
  if (!res.ok) {
    log(`job-pro list unavailable: ${res.error}`);
    return [];
  }
  const json = extractJson(res.stdout);
  const out = [];
  const push = (slug, name) => {
    if (slug && typeof slug === 'string') out.push({ slug, name: name || slug });
  };
  if (Array.isArray(json)) {
    for (const it of json) {
      if (typeof it === 'string') push(it, it);
      else if (it && typeof it === 'object') push(it.slug || it.id || it.key || it.company, it.name || it.display || it.company);
    }
  } else if (json && typeof json === 'object') {
    // grouped by ATS family: { family: [ ... ] } or { companies: [...] }
    const flat = json.companies || json.adapters || json;
    if (Array.isArray(flat)) {
      for (const it of flat) {
        if (typeof it === 'string') push(it, it);
        else if (it && typeof it === 'object') push(it.slug || it.id || it.key || it.company, it.name || it.display);
      }
    } else if (flat && typeof flat === 'object') {
      for (const [family, members] of Object.entries(flat)) {
        if (Array.isArray(members)) {
          for (const it of members) {
            if (typeof it === 'string') push(it, it);
            else if (it && typeof it === 'object') push(it.slug || it.id || it.key || it.company, it.name || family);
          }
        }
      }
    }
  }
  return out;
}

// Pure company-diff selector (exported for offline verification): the job-pro
// companies to actually query = explicit list, else (all listed) minus HR
// coverage minus native-tracked exclusions.
export function selectDiffTargets(all, hrCompanies, excludeSet, canonicalCompany, configuredList) {
  if (Array.isArray(configuredList) && configuredList.length) {
    return configuredList.map(c => ({ slug: c, name: c }));
  }
  return all.filter(c => {
    const canon = canonicalCompany(c.name || c.slug);
    if (!canon) return false;
    if (excludeSet.has(canon)) return false;   // native-tracked: never via CLI
    return !hrCompanies.has(canon);            // already covered by HR
  });
}

async function runJobPro(jobPro, hrCompanies, excludeSet, canonicalCompany, displayFor, ctx = {}) {
  if (!jobPro || !jobPro.command) return { rows: [], skipped: 'no command configured', diff: [] };
  const scope = jobPro.scope || 'all'; // job-pro supports campus | intern | all (NOT social)
  const keywords = Array.isArray(jobPro.keywords) && jobPro.keywords.length ? jobPro.keywords : ['AI'];
  const runOpts = {
    cwd: resolveSourceDir(jobPro, 'JOB_PRO_DIR'),
    timeoutMs: Number(jobPro.timeout_ms) || CLI_TIMEOUT_MS,
  };
  // In-process enrichment. `fetch_details: false` still turns it off; if the
  // script or the pinned package is missing we collect metadata only — there is
  // deliberately no per-row npx fallback, that path cost ~2.8s a row.
  const enrichCfg = resolveEnrichConfig(jobPro);
  const wantDetails = jobPro.fetch_details !== false;
  const fetchDetails = wantDetails && enrichCfg.available;
  if (wantDetails && !enrichCfg.available) {
    log(`[warn] job-pro JD enrichment OFF: ${enrichCfg.reason}`);
    log('[warn] rows are still collected metadata-only; nothing is retried per row.');
  }
  const detailLimit = Number(jobPro.detail_limit) || 0; // cap per company (0 = no cap)
  const all = listJobProCompanies(jobPro, runOpts);
  if (all.length === 0) {
    return { rows: [], skipped: 'job-pro list returned nothing (CLI missing/offline?)', diff: [] };
  }

  // Which companies to query: auto-diff (job-pro minus HR coverage minus
  // exclusions), or an explicit list from config.
  let targets = selectDiffTargets(all, hrCompanies, excludeSet, canonicalCompany, jobPro.companies);
  const jpLimit = Number(jobPro.limit) || 0; // smoke-test cap (mirrors --limit)
  if (jpLimit > 0) targets = targets.slice(0, jpLimit);
  log(`job-pro: ${all.length} company(ies) listed, diff targets: ${targets.map(t => t.slug).join(', ') || '(none)'}`);

  // PHASE 1 — metadata only. One `search` per company per keyword; post_id is
  // dropped by toCacheRow, so pair each cache row with the id the raw CLI
  // position carried (matched by URL), bucketed per company and deduped by pid
  // (a posting surfaces under several keywords — it must be fetched once).
  const rows = [];
  const failures = [];
  const pendingBySlug = new Map(); // slug -> Map<pid, { row, pid }>
  let noId = 0;
  for (const t of targets) {
    const canon = canonicalCompany(t.name || t.slug);
    if (excludeSet.has(canon)) continue; // re-check against explicit excludes
    for (const kw of keywords) {
      const res = runCli(jobPro.command, [t.slug, 'search', String(kw), '--scope', scope, '--compact'], runOpts);
      if (!res.ok) { failures.push(`${t.slug}/${kw}: ${res.error}`); continue; }
      const parsed = parseRows(res.stdout, 'job-pro', canonicalCompany, displayFor, t.name || t.slug);
      for (const r of parsed.rows) rows.push(r);
      if (!fetchDetails) continue;
      const json = extractJson(res.stdout);
      const positions = Array.isArray(json?.positions) ? json.positions : [];
      const idByUrl = new Map();
      for (const p of positions) {
        const u = String(p.apply_url || p.url || '').trim();
        if (u) idByUrl.set(u, extractPostId(p));
      }
      let bucket = pendingBySlug.get(t.slug);
      if (!bucket) { bucket = new Map(); pendingBySlug.set(t.slug, bucket); }
      for (const r of parsed.rows) {
        const pid = idByUrl.get(r.url) || extractPostId({ url: r.url });
        if (!pid) { noId++; continue; }
        if (!bucket.has(pid)) bucket.set(pid, { row: r, pid });
      }
    }
  }

  // PHASE 2 — enrich survivors only, one child process per company.
  //   (a) the keyword/title survivor test runs BEFORE the queue is built;
  //   (b) freshness is decided by the child (non-empty body + fetched_at within
  //       jd_max_age_days), so a row enriched in an earlier run is skipped;
  //   (c) the cache is checkpointed after every company, so an interrupted run
  //       keeps everything already merged.
  let enriched = 0;
  let detailFails = 0;
  let survivors = 0;
  const agg = { companies: 0, fetched: 0, skipped: 0, failed: 0, salvaged: 0, wall_ms: 0 };
  const failureKinds = {};
  const perCompany = [];
  for (const [slug, bucket] of pendingBySlug) {
    const candidates = [...bucket.values()];
    const keep = candidates.filter(it => survivorByTitle(it.row, keywords));
    if (detailLimit > 0 && keep.length > detailLimit) keep.length = detailLimit;
    survivors += keep.length;
    if (!fetchDetails || keep.length === 0) {
      if (fetchDetails) log(`job-pro/${slug}: 0 survivor(s) of ${candidates.length} row(s), nothing to enrich`);
      continue;
    }
    const r = enrichCompanyViaChild({ slug, items: keep, cfg: enrichCfg, priorRows: ctx.priorCache || [], dryRun: !!ctx.dryRun });
    agg.companies++;
    agg.fetched += r.stats.fetch;
    agg.skipped += r.stats.skip;
    agg.failed += r.stats.failed;
    agg.wall_ms += r.stats.wall_ms;
    agg.salvaged += r.salvaged || 0;
    if (!r.ok) {
      failures.push(`${slug}/enrich: ${r.error}`);
      // Bodies salvaged from the checkpoint are applied by the loop below, so
      // only rows we truly got nothing for count as a detail miss.
      detailFails += Math.max(0, keep.length - r.stats.skip - r.salvaged);
      if (!r.salvaged) log(`job-pro/${slug}: enrichment child failed (${r.error}); rows kept metadata-only`);
    }
    for (const f of r.failures) failureKinds[f.kind || 'other'] = (failureKinds[f.kind || 'other'] || 0) + 1;

    if (ctx.dryRun) {
      log(`[dry-run] job-pro/${slug} [${r.family || '?'} conc=${r.concurrency}]: candidates=${candidates.length} survivors=${keep.length} plan: total=${r.plan ? r.plan.total : '?'} skip(fresh)=${r.plan ? r.plan.skip : '?'} fetch=${r.plan ? r.plan.fetch : '?'}`);
      perCompany.push({ slug, family: r.family, concurrency: r.concurrency, candidates: candidates.length, survivors: keep.length, plan: r.plan });
      continue;
    }

    let withJd = 0;
    for (const it of keep) {
      const d = r.byId.get(it.pid);
      if (!d) continue;
      // detailBody() guards on the description STRING; buildDetailText() needs
      // the whole OBJECT to fold description + requirements together.
      const text = detailBody(d) ? buildDetailText(d) : '';
      if (!text) continue;
      it.row.description = text;                          // additive: metadata untouched
      it.row.jd_fetched_at = d.fetched_at || new Date().toISOString();
      if (!it.row.location && Array.isArray(d.work_cities) && d.work_cities.length) {
        it.row.location = d.work_cities.map(c => (c && typeof c === 'object' ? c.name : String(c))).filter(Boolean).join(', ');
      }
      if (!it.row.recruit_label && d.recruit_label) it.row.recruit_label = String(d.recruit_label);
      withJd++;
    }
    enriched += withJd;
    perCompany.push({
      slug, family: r.family, concurrency: r.concurrency,
      candidates: candidates.length, survivors: keep.length,
      skip: r.stats.skip, fetch: r.stats.fetch, ok: r.stats.ok, fail: r.stats.failed,
      with_jd: withJd, failures: r.failures.length, wall_ms: r.stats.wall_ms,
      salvaged: r.salvaged || 0,
    });
    log(`job-pro/${slug} [${r.family || '?'} conc=${r.concurrency}]: candidates=${candidates.length} survivors=${keep.length} skip=${r.stats.skip} fetch=${r.stats.fetch} ok=${r.stats.ok} fail=${r.stats.failed} jd=${withJd} (${r.stats.wall_ms}ms)`);

    // Priority 3: atomic cache checkpoint after each company.
    if (typeof ctx.onCheckpoint === 'function') {
      try { ctx.onCheckpoint(slug, rows); } catch (e) { log(`[warn] checkpoint after ${slug} failed: ${e.message}`); }
    }
  }

  if (Object.keys(failureKinds).length) {
    log(`job-pro: detail failures by kind: ${Object.entries(failureKinds).map(([k, v]) => `${k}=${v}`).join(', ')} (ids in local/cache/jobpro-enriched-<slug>.json.failures.json)`);
  }
  if (failures.length) log(`job-pro: ${failures.length} query failure(s), e.g. ${failures.slice(0, 3).join(' ; ')}`);
  log(`job-pro: ${rows.length} row(s) from ${targets.length} diff company(ies); survivors queued=${survivors} (${noId} row(s) had no post_id), ${enriched} enriched with JD, ${agg.skipped} skipped as fresh, ${detailFails + agg.failed} detail miss/failure(s)`);
  return {
    rows,
    skipped: null,
    diff: targets.map(t => t.slug),
    enriched,
    detailFails,
    enrichment: {
      mode: fetchDetails ? 'in-process' : (wantDetails ? 'unavailable' : 'disabled'),
      reason: fetchDetails ? null : enrichCfg.reason,
      survivors_queued: survivors,
      rows_without_post_id: noId,
      ...agg,
      failures_by_kind: failureKinds,
      per_company: perCompany,
    },
  };
}

// ── Merge + de-dup ──────────────────────────────────────────────────
export function normTitle(title) {
  return String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function normLocation(loc) {
  const sep = /[,，、;；/｜|]+/;
  const parts = (Array.isArray(loc) ? loc.map(String) : String(loc || '').split(sep))
    .map(s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return [...new Set(parts)].sort().join(' ');
}

export function dedupe(rows, preferOrder) {
  const rank = new Map((Array.isArray(preferOrder) ? preferOrder : ['native', 'job-pro', 'hiring-radar', 'websearch'])
    .map((s, i) => [s, i]));
  const best = new Map();
  for (const row of rows) {
    const key = `${row.company_norm}|${normTitle(row.title)}|${normLocation(row.location)}`;
    const r = rank.has(row.source) ? rank.get(row.source) : rank.size + 1;
    const existing = best.get(key);
    if (!existing || r < existing._rank) {
      best.set(key, { ...row, _rank: r });
    }
  }
  return [...best.values()].map(({ _rank, ...row }) => row);
}

// ── Atomic cache write ──────────────────────────────────────────────
function writeCache(cacheRelPath, rows) {
  const abs = path.resolve(ROOT, cacheRelPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
  renameSync(tmp, abs);
  return abs;
}

// ── Readiness doctor (`--check`) ─────────────────────────────────────
// Turns every external prerequisite into an actionable probe so a user learns
// what is missing BEFORE a real collection run, not from a silent 0-row cache.
// Non-fatal: it always returns; nothing here writes files or fetches packages.
function chromeCandidatePaths() {
  if (IS_WIN) {
    return [
      process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
      process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google/Chrome/Application/chrome.exe'),
    ].filter(Boolean);
  }
  return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
}

function findPyScriptToken(argv) {
  return argv.find(tok => /\.py$/i.test(tok));
}

function runCheck({ cn, boards }) {
  const checks = [];
  const add = (name, level, detail, hint) => checks.push({ name, level, detail, hint: hint || null });

  // node (self)
  add('node', 'ok', process.version);

  // Hiring-Radar interpreter + script
  const hr = cn.hiring_radar || {};
  const hrArgv = splitCommand(hr.command || '');
  const hrDir = resolveSourceDir(hr, 'HIRING_RADAR_DIR');
  if (!hr.command) {
    add('hiring-radar', 'fail', 'no command configured', 'set cn_sources.hiring_radar.command');
  } else {
    const hrExe = resolveExe(hrArgv[0]);
    const ver = runCli(`${hrExe} --version`, [], { cwd: hrDir, timeoutMs: 20_000 });
    add('hiring-radar: interpreter', ver.ok ? 'ok' : 'fail', ver.ok ? ver.stdout.trim().split('\n')[0] : ver.error,
      ver.ok ? null : `install Python 3.8+ and make \`${hrArgv[0]}\` resolvable`);
    const pyTok = findPyScriptToken(hrArgv.slice(1));
    if (!pyTok) {
      add('hiring-radar: script', 'warn', 'command has no *.py path', 'run hiring_radar.py from its clone dir');
    } else {
      const scriptAbs = path.resolve(hrDir, pyTok);
      add('hiring-radar: script', existsSync(scriptAbs) ? 'ok' : 'fail', `${existsSync(scriptAbs) ? 'found' : 'missing'}: ${scriptAbs}`,
        existsSync(scriptAbs) ? null
          : 'git clone https://github.com/simonlin1212/Hiring-Radar, then set cn_sources.hiring_radar.dir (or HIRING_RADAR_DIR) to its folder');
    }
    // pycryptodome — only Moka-family CN companies need it
    if (hr.ok !== false) {
      const cry = runCli(hrExe, ['-c', 'import Crypto'], { cwd: hrDir, timeoutMs: 20_000 });
      add('hiring-radar: pycryptodome', cry.ok ? 'ok' : 'warn', cry.ok ? 'importable' : 'ModuleNotFoundError: Crypto',
        cry.ok ? null : 'pip install pycryptodome (only needed for Moka-family companies; others unaffected)');
    }
  }

  // job-pro runtime + package + Chrome
  const jp = cn.job_pro || {};
  const jpArgv = splitCommand(jp.command || '');
  const jpDir = resolveSourceDir(jp, 'JOB_PRO_DIR');
  if (!jp.command) {
    add('job-pro', 'fail', 'no command configured', 'set cn_sources.job_pro.command');
  } else {
    const jpExe = resolveExe(jpArgv[0]);
    const ver = runCli(`${jpExe} --version`, [], { cwd: jpDir, timeoutMs: 30_000 });
    add('job-pro: runtime', ver.ok ? 'ok' : 'fail', ver.ok ? ver.stdout.trim().split('\n')[0] : ver.error,
      ver.ok ? null : `install Node/npm so \`${jpArgv[0]}\` is resolvable`);
    add('job-pro: package', 'info', `${jpArgv.slice(1).join(' ') || '@ha7ch/job-pro'} fetched on first run`,
      'first invocation downloads the package (needs npm registry access); set JOB_PRO scope/keywords in cn_sources');
    const chrome = chromeCandidatePaths().find(p => existsSync(p));
    add('job-pro: Chrome (Lilith only)', chrome ? 'ok' : 'info', chrome || 'not found',
      chrome ? null : 'only the Lilith adapter drives local Chrome; the other 49 job-pro companies are unaffected');
  }

  // In-process JD enrichment: the fast path needs the script AND the pinned
  // package. Without them collection still works, but job-pro rows arrive
  // metadata-only — so this must be visible BEFORE a run, not after.
  const jpCfg = resolveEnrichConfig(cn.job_pro || {});
  if (jpCfg.available) {
    const storeDir = jpCfg.storeDir;
    const stores = existsSync(storeDir)
      ? readdirSync(storeDir).filter(f => /^jobpro-enriched-.+\.json$/.test(f)).length
      : 0;
    add('job-pro: enrichment', 'ok',
      `in-process via ${path.relative(ROOT, jpCfg.script)} @ ${path.relative(ROOT, jpCfg.pkgRoot)} (${stores} resume store(s))`);
    if (Number((cn.job_pro || {}).jd_max_age_days) === 0) {
      add('job-pro: jd_max_age_days', 'warn', '0 = refetch every body on every run', 'set it to e.g. 14 to reuse fresh JD text');
    }
  } else {
    add('job-pro: enrichment', (cn.job_pro || {}).fetch_details === false ? 'info' : 'warn', jpCfg.reason,
      (cn.job_pro || {}).fetch_details === false
        ? 'fetch_details: false — job-pro rows will be metadata-only by choice'
        : 'npm install --prefix local @ha7ch/job-pro@1.2.1 (rows otherwise land metadata-only)');
  }

  // cache state
  const cacheAbs = path.resolve(ROOT, cn.cache || 'data/cn-jobs.json');
  if (existsSync(cacheAbs)) {
    let n = 0;
    try { const j = JSON.parse(readFileSync(cacheAbs, 'utf-8')); n = Array.isArray(j) ? j.length : 0; } catch { /* corrupt */ }
    add('cache', n > 0 ? 'ok' : 'warn', `${n} row(s) at ${cacheAbs}`, n > 0 ? null : 'run `node local/scripts/cn_bridge.mjs` to populate');
  } else {
    add('cache', 'warn', `absent: ${cacheAbs}`, 'run `node local/scripts/cn_bridge.mjs` to populate');
  }

  // scan wiring: an enabled job_boards local-parser pointing at the reader
  const wired = boards.some(b => b && b.enabled !== false && b.parser && /cn_cache_reader\.mjs$/i.test(String(b.parser.script || '')));
  add('scan wiring', wired ? 'ok' : 'fail', wired ? 'cn_cache_reader.mjs present in job_boards' : 'no enabled cn_cache_reader.mjs board',
    wired ? null : 'add the 中国岗位缓存 (cn-jobs) job_boards entry (see portals.yml)');

  return checks;
}

function printCheck(checks, asJson) {
  if (asJson) { process.stdout.write(JSON.stringify({ status: 'check', checks }, null, 2)); return; }
  const line = '-'.repeat(60);
  console.error('\ncn_bridge readiness check');
  console.error(line);
  for (const c of checks) {
    console.error(`[${c.level.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`);
    if (c.hint) console.error(`         -> ${c.hint}`);
  }
  const blocking = checks.filter(c => c.level === 'fail').length;
  console.error(line);
  console.error(blocking ? `${blocking} blocking issue(s) - fix before a real run (WARN/INFO are optional).` : 'No blocking issues. WARN/INFO are optional gates.');
  process.exitCode = blocking ? 1 : 0;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const asJson = argv.includes('--json');

  if (argv.includes('--check') || argv.includes('--doctor')) {
    const cfg = loadConfig();
    printCheck(runCheck(cfg), asJson);
    return;
  }

  const { cn, tracked, aliases } = loadConfig();
  const canonicalCompany = buildCanonicalizer(aliases);
  const displayFor = buildDisplayMap(aliases);
  const excludeSet = buildExcludeSet({ cn, tracked }, canonicalCompany);
  const cacheRelPath0 = cn.cache || 'data/cn-jobs.json';
  // --cache <path> redirects the output cache. A bounded smoke run (--limit) only
  // collects the rows it queried, and each run writes exactly what it collected —
  // without this override a 1-company sample would truncate the production cache.
  const cacheIdx = argv.indexOf('--cache');
  const cacheRelPath = (cacheIdx !== -1 && argv[cacheIdx + 1])
    ? String(argv[cacheIdx + 1])
    : cacheRelPath0;
  const prefer = cn.dedup?.prefer || ['native', 'job-pro', 'hiring-radar', 'websearch'];

  // CLI overrides for safe bounded testing (do not edit config to smoke-test):
  //   --limit N                 cap the number of HR local keys queried
  //   --companies k1,k2         restrict HR to specific parser keys (comma/space)
  //   --detail-cap N            cap job-pro `detail` fetches per company (smoke-test the JD enrichment fast)
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    const n = Number(argv[limitIdx + 1]) || 0;
    cn.hiring_radar = { ...cn.hiring_radar, limit: n };
    cn.job_pro = { ...cn.job_pro, limit: n }; // bound both sources for smoke tests
  }
  const dcapIdx = argv.indexOf('--detail-cap');
  if (dcapIdx !== -1 && argv[dcapIdx + 1]) {
    cn.job_pro = { ...cn.job_pro, detail_limit: Number(argv[dcapIdx + 1]) || 0 };
  }
  const compIdx = argv.indexOf('--companies');
  if (compIdx !== -1 && argv[compIdx + 1]) {
    const keys = String(argv[compIdx + 1]).split(/[ ,]+/).filter(Boolean);
    cn.hiring_radar = { ...cn.hiring_radar, companies: keys };
  }
  // --jp-companies k1,k2  force specific job-pro slugs (bypasses auto-diff), so a
  // single ATS family can be sampled on its own.
  const jpcIdx = argv.indexOf('--jp-companies');
  if (jpcIdx !== -1 && argv[jpcIdx + 1]) {
    const slugs = String(argv[jpcIdx + 1]).split(/[ ,]+/).filter(Boolean);
    cn.job_pro = { ...cn.job_pro, companies: slugs };
  }

  log(`exclude set: ${excludeSet.size} company(ies) (tracked_companies + exclude_companies)`);

  // Read the previous cache first: it is the freshness baseline for incremental
  // skipping (jd text + jd_fetched_at), and the seed for a resume store that has
  // not been written yet. The baseline is always the CONFIGURED cache — a smoke
  // run writing to --cache still sees what production already has. Unreadable or
  // absent just means "no baseline".
  const cacheAbs = path.resolve(ROOT, cacheRelPath0);
  let priorCache = [];
  if (existsSync(cacheAbs)) {
    try {
      const j = JSON.parse(readFileSync(cacheAbs, 'utf-8'));
      if (Array.isArray(j)) priorCache = j;
      log(`previous cache loaded: ${priorCache.length} row(s) (freshness baseline)`);
    } catch (e) {
      log(`[warn] previous cache unreadable (${e.message}); no freshness baseline`);
    }
  } else {
    log('previous cache absent; starting empty');
  }

  const hr = runHiringRadar(cn.hiring_radar, canonicalCompany, displayFor);
  let checkpointed = 0;
  const jp = await runJobPro(cn.job_pro, hr.companies, excludeSet, canonicalCompany, displayFor, {
    dryRun,
    priorCache,
    // Mid-run durability: rewrite the cache (atomic tmp+rename) after every
    // enriched company, so an interrupted run keeps what it already fetched.
    onCheckpoint: (slug, rowsSoFar) => {
      if (dryRun) return;
      const part = [...rowsSoFar, ...hr.rows].filter(r => !excludeSet.has(r.company_norm));
      const dedupedPart = dedupe(part, prefer);
      writeCache(cacheRelPath, dedupedPart);
      checkpointed++;
      log(`[checkpoint] after ${slug}: ${dedupedPart.length} row(s) written`);
    },
  });

  // Drop any excluded company that slipped through a partial HR run.
  const combined = [...jp.rows, ...hr.rows].filter(r => !excludeSet.has(r.company_norm));

  const before = combined.length;
  const deduped = dedupe(combined, prefer);
  const excludedDropped = before - deduped.length;

  log(`merged ${before} row(s) -> ${deduped.length} after dedup (${excludedDropped} duplicate(s) collapsed)`);

  // Footgun guard: a --limit run legitimately collects a fraction of the universe,
  // and writing that to the PRODUCTION cache silently shrinks it to the sample.
  // (Guard only fires when the write target IS the configured cache — an
  // --cache override is exactly the escape hatch this warning would suggest.)
  if (!dryRun && cacheRelPath === cacheRelPath0 && priorCache.length && deduped.length < priorCache.length * 0.5) {
    log(`[warn] this run collected ${deduped.length} row(s) vs ${priorCache.length} in the existing cache — writing here TRUNCATES it.`);
    log('[warn] intended for a smoke test? add --cache local/cache/_sample-cn-jobs.json to keep the production cache intact.');
  }

  let abs = null;
  if (!dryRun) {
    abs = writeCache(cacheRelPath, deduped);
    log(`wrote cache -> ${abs} (${checkpointed} mid-run checkpoint(s))`);
  } else {
    log('dry run — cache not written');
  }

  const summary = {
    status: 'ok',
    cache: abs || path.resolve(ROOT, cacheRelPath),
    dryRun,
    rows_written: deduped.length,
    raw_rows: before,
    duplicates_collapsed: excludedDropped,
    exclude_companies: [...excludeSet],
    hiring_radar: { rows: hr.rows.length, companies_covered: hr.companies.size, skipped: hr.skipped, meta: hr.meta },
    job_pro: {
      rows: jp.rows.length, diff_companies: jp.diff, skipped: jp.skipped,
      enriched_with_jd: jp.enriched ?? 0, detail_failures: jp.detailFails ?? 0,
      enrichment: jp.enrichment ?? null,
    },
    mid_run_checkpoints: checkpointed,
  };
  if (asJson) process.stdout.write(JSON.stringify(summary, null, 2));
  else log(`DONE. hiring-radar=${hr.rows.length}, job-pro=${jp.rows.length}, cached=${deduped.length}`);
}

try {
  if (isMainModule(import.meta.url)) main();
} catch (err) {
  log(`fatal: ${err.message}`);
  process.exit(1);
}
