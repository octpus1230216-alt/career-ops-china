#!/usr/bin/env node
/**
 * enrich-details.mjs — 进程内批量富化 JD 正文(不走 CLI 冷启动)
 *
 * 用法(通常由 cn_bridge.mjs 按公司逐批调用,不是每条 spawn):
 *   node local/scripts/enrich-details.mjs --input <rows.json> --company xiaohongshu \
 *        --output <store.json> --package-root local/node_modules/@ha7ch/job-pro \
 *        --concurrency 3 --jitter 200 --max-age-days 14 --retries 2 --checkpoint-every 20
 *
 * 运行依赖(硬性):
 *   - Node >= 20 (顶层 await / fs/promises 别名 / AbortSignal.timeout)。
 *   - 文件后缀为 .mjs => 由扩展名判定 ESM,不依赖最近 package.json 的 "type"
 *     字段(career-ops 根 package.json 没有 type,若这里是 .js 会被当 CJS 解析
 *     而报语法错)。若日后改名为 .js,必须让所在目录的 package.json 带
 *     "type": "module"。
 *
 * 设计要点(来自第 0-3 步实测,勿重复验证):
 *   - 单进程 import dist/<company>.js 后直调 fetchPositionDetail(postId),
 *     把 N 次 npx 冷启动(2.8s/条)摊成 1 次进程启动。
 *   - 包内无上游/本地缓存(同 id 连打两次 103ms/70ms) => 增量跳过必须自建。
 *   - 家族延迟 skew 大(小红书 92ms,Moka/北森系 ~700ms) => 并发保守 + 抖动 + 连败降并发。
 *   - 部分家族 requirements 为空 => description / requirements 分开存,容忍 description-only。
 *
 * 输出文件自身充当续跑缓存:存在则读回做 baseline,新鲜(fetched_at 在
 * max-age-days 内且正文非空)的条目直接跳过,不打上游。
 * 失败条目额外写 <output>.failures.json,带 kind(429/timeout/http/other)分类。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const num = (name, def) => {
  const v = arg(name, undefined);
  if (v === undefined) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const INPUT = arg('input', undefined);
const COMPANY = arg('company', undefined);
const CONCURRENCY = Math.max(1, Math.min(8, num('concurrency', 3)));
const JITTER = Math.max(0, num('jitter', 200));
const MAX_AGE_DAYS = num('max-age-days', 14);
const RETRIES = Math.max(0, num('retries', 2));
const CHECKPOINT_EVERY = Math.max(1, num('checkpoint-every', 20));
const TIMEOUT_MS = Math.max(1000, num('timeout-ms', 30000));
const DRY_RUN = flag('dry-run');
if (!INPUT || !COMPANY) {
  console.error('usage: node enrich-details.mjs --input rows.json --company <slug> [--output store.json] [--package-root <dir>] [--concurrency 3] [--jitter 200] [--max-age-days 14] [--retries 2] [--checkpoint-every 20] [--timeout-ms 30000] [--dry-run]');
  process.exit(2);
}
const OUTPUT = arg('output', INPUT.replace(/\.json$/i, '') + '.enriched.json');

// ---------- locate @ha7ch/job-pro dist ----------
function resolvePackageRoot() {
  const explicit = arg('package-root', undefined);
  if (explicit) return path.resolve(explicit);
  try {
    const req = createRequire(import.meta.url);
    // req.resolve('@ha7ch/job-pro/package.json') already points at the package
    // root's own manifest, so ONE dirname is all that's needed.
    return path.dirname(req.resolve('@ha7ch/job-pro/package.json'));
  } catch { /* fall through */ }
  // Script-relative first: local/scripts/ -> local/node_modules (where cn_bridge
  // installs the pinned copy), then a cwd-relative install. No hardcoded
  // machine-specific paths.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'node_modules', '@ha7ch', 'job-pro'),
    path.join(process.cwd(), 'node_modules', '@ha7ch', 'job-pro'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const PKG = resolvePackageRoot();
if (!PKG) { console.error('[err] cannot locate @ha7ch/job-pro (use --package-root)'); process.exit(2); }
// Hardening: a resolved root that isn't the package is a resolution bug (see
// last round's triple-dirname ENOENT). Fail loudly instead of scanning a wrong
// directory, which would surface as "module not found" for every company.
if (path.basename(PKG) !== 'job-pro' || path.basename(path.dirname(PKG)) !== '@ha7ch') {
  console.error(`[err] resolved package root is not @ha7ch/job-pro: ${PKG}`);
  console.error('[hint] pass --package-root <.../node_modules/@ha7ch/job-pro> explicitly.');
  process.exit(3);
}
const DIST = path.join(PKG, 'dist');
const MOD_PATH = path.join(DIST, `${COMPANY}.js`);
if (!existsSync(MOD_PATH)) {
  let avail = '(dist not readable)';
  try {
    avail = readdirSync(DIST).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')).join(', ');
  } catch { /* keep the placeholder */ }
  console.error(`[err] module not found: ${MOD_PATH}\n[avail] ${avail}`);
  process.exit(3);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * (n + 1));
const URL_ID_RE = /(?:\/position\/|#\/job\/|\/job\/)(\d{6,}|[0-9a-f]{8}-[0-9a-f-]{20,})/i;
function postIdOf(rec) {
  const direct = String(rec.post_id ?? rec.id ?? rec.job_id ?? '').trim();
  if (direct) return direct;
  const u = String(rec.apply_url || rec.url || '');
  const m = u.match(URL_ID_RE);
  return m ? m[1] : '';
}

// Failure taxonomy, so cn_bridge can decide whether a re-run is worth it
// (429/timeout => back off and retry later; other => likely a dead posting).
function classifyError(err, message) {
  const m = String(message || '');
  if (err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || /timed?\s*out|timeout/i.test(m))) return 'timeout';
  if (/\b429\b/.test(m) || /rate.?limit|too many requests/i.test(m)) return 'http-429';
  if (/\b(40[1-9]|5\d{2})\b/.test(m) || /\bhttp\s*(error|status)\b/i.test(m)) return 'http';
  return 'other';
}

// ---------- adapter ----------
const mod = await import(pathToFileURL(MOD_PATH).href);
if (typeof mod.fetchPositionDetail !== 'function') {
  console.error(`[err] ${COMPANY}: fetchPositionDetail is not exported (package layout changed?).`);
  console.error(`[err] exports: ${Object.keys(mod).join(', ')}`);
  console.error('[hint] fallback: call node_modules\\.bin\\job-pro directly (serial / low concurrency).');
  process.exit(3);
}
// The deep-imported module's own entry point for one posting's full body.
const fetchDetail = mod.fetchPositionDetail;

// NEVER pass a second argument: the package's own signatures disagree about
// what arg 2 means — baidu(postId, recruitType="GRADUATE"), iqiyi(postId,
// portal="job"), huawei(postId, opts={}) — an AbortSignal there silently
// repoints the request (or breaks it) instead of timing it out. Bound latency
// from our side instead; an orphaned promise just settles after we moved on.
const fetchDetailWithTimeout = (id) => Promise.race([
  fetchDetail(id),
  sleep(TIMEOUT_MS).then(() => { throw new Error(`client timeout after ${TIMEOUT_MS}ms`); }),
]);

// ---------- input + resume baseline ----------
const rawIn = JSON.parse(readFileSync(INPUT, 'utf8'));
const inPositions = Array.isArray(rawIn) ? rawIn : (rawIn.positions || []);
if (!inPositions.length) { console.error('[err] input has no positions'); process.exit(2); }

let prior = new Map();
if (existsSync(OUTPUT)) {
  try {
    const p = JSON.parse(readFileSync(OUTPUT, 'utf8'));
    for (const rec of (p.positions || [])) {
      const k = postIdOf(rec);
      if (k) prior.set(k, rec);
    }
    console.log(`[resume] baseline from ${OUTPUT}: ${prior.size} record(s)`);
  } catch (e) {
    console.log(`[resume] existing output unreadable (${e.message}); starting fresh`);
  }
}

const nowMs = Date.now();
const isFresh = (rec) => {
  if (!rec || typeof rec.description !== 'string' || !rec.description.trim()) return false;
  if (MAX_AGE_DAYS <= 0) return false; // force refetch
  const t = Date.parse(rec.fetched_at || '');
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) <= MAX_AGE_DAYS * 86400_000;
};

// Build the output shell preserving INPUT order and all original fields.
const records = inPositions.map(rec => {
  const k = postIdOf(rec);
  const base = { ...rec, post_id: k || rec.post_id };
  const old = k ? prior.get(k) : undefined;
  return old ? { ...base, ...old, ...{ title: base.title || old.title } } : base;
});
const queue = [];
let skipped = 0;
records.forEach((rec, idx) => {
  if (isFresh(rec)) { skipped++; return; }
  if (!rec.post_id) { rec._no_id = true; return; }
  queue.push(idx);
});
console.log(`[plan] company=${COMPANY} total=${records.length} skip=${skipped} fetch=${queue.length} concurrency=${CONCURRENCY} jitter=${JITTER}ms max-age-days=${MAX_AGE_DAYS} retries=${RETRIES} checkpoint-every=${CHECKPOINT_EVERY} timeout-ms=${TIMEOUT_MS}`);
console.log(`[paths] input=${INPUT} output=${OUTPUT} module=${MOD_PATH}`);
if (DRY_RUN) { console.log('[dry-run] nothing fetched'); process.exit(0); }

// ---------- atomic checkpoint ----------
const failures = [];
function snapshot() {
  const out = {
    generated_at: new Date().toISOString(),
    company: COMPANY,
    total: records.length,
    enriched: records.filter(r => typeof r.description === 'string' && r.description.trim()).length,
    skipped,
    failed: failures.length,
    positions: records,
  };
  const tmp = `${OUTPUT}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
  renameSync(tmp, OUTPUT);
  return out;
}

// ---------- dynamic concurrent pool ----------
let limit = CONCURRENCY;
let i = 0;
let done = 0;
let consecFail = 0;
let consec429 = 0;
const t0 = Date.now();

async function worker() {
  while (true) {
    // Claim, but respect a shrunk pool: if we're over the new limit, hand the
    // item back and let another worker take it.
    if (done >= queue.length) return;
    const k = i++;
    if (k >= queue.length) return;
    if (k >= limit && limit < CONCURRENCY) { i--; return; }
    const idx = queue[k];
    const rec = records[idx];
    const id = String(rec.post_id);
    let attempt = 0;
    let err = null;
    let kind = 'other';
    let d = null;
    const s = Date.now();
    while (attempt <= RETRIES) {
      try {
        const res = await fetchDetailWithTimeout(id);
        if (res && res.ok === true) { d = res; err = null; break; }
        err = (res && res.message) || 'ok=false';
        kind = (res && res.status === 429) ? 'http-429' : classifyError(null, err);
      } catch (e) {
        err = String(e && e.message || e);
        kind = classifyError(e, err);
      }
      attempt++;
      if (attempt <= RETRIES) {
        // 429 gets a longer floor than a generic failure — hammering a rate
        // limiter is how a batch run gets an IP-level block.
        const floor = kind === 'http-429' ? 2000 : 300;
        const back = floor * 2 ** (attempt - 1) + rand(300);
        console.log(`[retry] ${id} attempt ${attempt}/${RETRIES} in ${back}ms [${kind}] (${err})`);
        await sleep(back);
      }
    }
    const ms = Date.now() - s;
    if (d) {
      rec.description = d.description || '';
      rec.requirements = d.requirements || '';
      if (d.direction) rec.direction = d.direction;
      if (d.recruit_label) rec.recruit_label = d.recruit_label;
      if (d.apply_url) rec.apply_url = d.apply_url;
      if (Array.isArray(d.work_cities) && d.work_cities.length) rec.work_cities = d.work_cities;
      rec.source = d.source || rec.source;
      rec.fetched_at = new Date().toISOString();
      done++; consecFail = 0; consec429 = 0;
      console.log(`[ok] ${id} ${ms}ms desc=${rec.description.length} req=${rec.requirements.length}`);
    } else {
      failures.push({ post_id: id, kind, error: err, ms, attempts: attempt });
      done++;
      consecFail++;
      if (kind === 'http-429') consec429++;
      console.log(`[fail] ${id} [${kind}] ${err}`);
      if (consec429 >= 2) {
        console.log('[throttle] rate-limited -> cooling down 15s');
        await sleep(15000);
        consec429 = 0;
      }
      if (consecFail >= 3 && limit > 1) {
        limit--; consecFail = 0;
        console.log(`[throttle] consecutive failures -> concurrency reduced to ${limit}`);
        snapshot();
      }
    }
    if (JITTER) await sleep(rand(JITTER));
    if (done % CHECKPOINT_EVERY === 0) {
      const snap = snapshot();
      console.log(`[checkpoint] ${done}/${queue.length} written (enriched=${snap.enriched})`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const snap = snapshot();
if (failures.length) {
  const byKind = {};
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  writeFileSync(`${OUTPUT}.failures.json`, JSON.stringify({
    company: COMPANY,
    generated_at: new Date().toISOString(),
    by_kind: byKind,
    failures,
  }, null, 2), 'utf8');
  console.log(`[failures] ${failures.length} (${Object.entries(byKind).map(([k, v]) => `${k}:${v}`).join(' ')}) -> ${OUTPUT}.failures.json`);
}
const elapsed = Date.now() - t0;
const avg = queue.length ? Math.round(elapsed / queue.length) : 0;
console.log(`[done] company=${COMPANY} fetched=${queue.length} ok=${queue.length - failures.length} failed=${failures.length} skipped=${skipped} enriched=${snap.enriched}/${snap.total} wall=${(elapsed / 1000).toFixed(2)}s avg=${avg}ms`);
