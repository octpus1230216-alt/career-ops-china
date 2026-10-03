#!/usr/bin/env node
/**
 * cn_cache_reader.mjs — READ-ONLY bridge between career-ops `local-parser`
 * and the Chinese job cache written by cn_bridge.mjs.
 *
 * career-ops provider contract (providers/local-parser.mjs):
 *   - Run as `node local/scripts/cn_cache_reader.mjs` (cwd pinned to repo root).
 *   - stdout MUST be a single JSON array of job objects, nothing else.
 *     Each object needs at least `title` and `url`; rows missing either are
 *     dropped here (and would also be dropped by the provider).
 *   - Any diagnostic output goes to stderr. On ANY failure we still print `[]`
 *     to stdout so the provider gets valid (empty) JSON, never a crash.
 *
 * This script NEVER runs any external CLI. It only reads the cache file that
 * cn_bridge.mjs produced. That keeps scan.mjs zero-token and deterministic:
 * the heavy Hiring-Radar / job-pro collection happens offline, out of band.
 *
 * Cache location precedence (mirrors cn_sources.cache in portals.yml):
 *   1. CN_JOBS_CACHE env override
 *   2. {CAREER_OPS_ROOT}/data/cn-jobs.json (via path-resolver)
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';

function log(msg) {
  // stdout is reserved for the JSON array. Everything else -> stderr.
  console.error(msg);
}

function resolveCachePath() {
  const env = process.env.CN_JOBS_CACHE?.trim();
  if (env) return path.resolve(getCareerOpsRoot(), env);
  return path.join(getCareerOpsRoot(), 'data', 'cn-jobs.json');
}

// career-ops compiles CJK location keywords (e.g. "北京") with a Unicode
// word-boundary regex. A trailing admin suffix ("北京市") glues a letter to
// the city name and FAILS the boundary, so location_filter WRONGLY drops the
// row. Strip trailing administrative suffixes so the bare city name is what
// scan compares against (same fix as local/scripts/jobhunt_bridge.py).
const LOCATION_SEP_RE = /[,，、;；/｜|]+/;
// Longest-first so a compound suffix (特别行政区 / 自治区) is caught before a
// short one.
const ADMIN_SUFFIXES = ['特别行政区', '自治州', '自治区', '地区', '市', '省', '县'];

function cleanLocationToken(token) {
  let t = String(token).trim();
  for (const suf of ADMIN_SUFFIXES) {
    if (t.length > suf.length && t.endsWith(suf)) {
      t = t.slice(0, t.length - suf.length);
      break;
    }
  }
  return t.trim();
}

function normalizeLocation(value) {
  if (!value) return '';
  let chunks;
  if (Array.isArray(value)) chunks = value.filter(Boolean).map(String);
  else if (typeof value === 'object') chunks = [String(value.name || value.text || '')];
  else chunks = [String(value)];
  const cleaned = [];
  const seen = new Set();
  for (const chunk of chunks) {
    for (const tok of String(chunk).split(LOCATION_SEP_RE)) {
      const c = cleanLocationToken(tok);
      if (c && !seen.has(c)) {
        seen.add(c);
        cleaned.push(c);
      }
    }
  }
  return cleaned.join(', ');
}

// Coerce an optional posting date to epoch ms, matching local-parser's own
// tolerance (epoch number or Date.parse-able string); anything else -> absent.
function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms) && ms > 0) return ms;
  }
  return undefined;
}

function firstPostedAt(row) {
  for (const key of ['postedAt', 'posted_at', 'date', 'date_updated', 'published_at', 'publishedAt']) {
    const ms = toEpochMs(row[key]);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function pickUrl(row) {
  const raw = String(row.url || row.apply_url || row.applyUrl || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

// ── Recruit-channel gate (漏洞二修正：校招/实习岗穿透) ──────────────────
// The cache carries the recruit channel in the URL path segment and in
// `recruit_label`, and only *sometimes* in the title, so `title_filter.negative:
// 实习` alone cannot stop it (verified against data/cn-jobs.json:
// talent.baidu.com/jobs/detail/INTERN/{id}, campus.jd.com/#/newDetails?…,
// xiaomi.jobs.f.mioffice.cn/campus/position, app.mokahr.com/campus-recruitment/
// cambricon all survived with a perfectly "senior-sounding" title).
// Detection is POSITIVE-only: a row is dropped only when it carries actual
// campus/intern evidence; anything unknown stays, so 社招 coverage can never be
// silently lost to a too-broad pattern.
const INTERN_RE = /(实习|intern(?:ship)?\b)/i;
const CAMPUS_RE = /(campus|school|graduate|校招|校园|应届|\d{2}届|20\d{2}届|管培生|trainee|redstar|rising star|飞星计划|顶尖ai人才计划|顶尖人才计划)/i;
// A token that merely CONTAINS "campus" but is explicitly non-campus
// (talent.antgroup.com/off-campus-position is 社招 — must stay).
const OFF_CAMPUS_RE = /off-?campus/i;

// The channel lives in the HOST on several boards (campus.jd.com,
// campus.pingan.com, hr-campus.vivo.com) as much as in the path, so both are
// tokenised. `intern(?:ship)?\b` deliberately does NOT match "Internal …".
function urlTokens(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const raw = `${u.hostname}.${u.pathname}${u.search ? ' ' + decodeURIComponent(u.search) : ''} ${u.hash}`;
  return raw.split(/[^\w\-.%]+/).flatMap((s) => s.split('.')).filter(Boolean);
}

/**
 * @returns {{kind: 'intern'|'campus'|'open', evidence: string}}
 */
function classifyRecruit(row, url) {
  const title = String(row.title || row.name || '');
  const label = String(row.recruit_label ?? '');
  const segs = urlTokens(url).filter((s) => !OFF_CAMPUS_RE.test(s));
  // Order matters: an intern signal anywhere wins over a campus signal, and a
  // title signal wins over a label signal (the label is a job FAMILY, not a
  // channel, on some boards — e.g. Baidu's 综合/产品/技术).
  if (INTERN_RE.test(title)) return { kind: 'intern', evidence: 'title' };
  if (segs.some((s) => INTERN_RE.test(s))) return { kind: 'intern', evidence: 'url' };
  if (INTERN_RE.test(label)) return { kind: 'intern', evidence: 'label' };
  if (CAMPUS_RE.test(title)) return { kind: 'campus', evidence: 'title' };
  if (segs.some((s) => CAMPUS_RE.test(s))) return { kind: 'campus', evidence: 'url' };
  if (/校园|校招|应届|school_recruit|intern_recruit/.test(label)) return { kind: 'campus', evidence: 'label' };
  return { kind: 'open', evidence: '' };
}

// ── Detail-URL normalisation (缺口三修正) ───────────────────────────────
// Two producer families emit deep links that do NOT resolve. Both halves were
// verified live on 2026-10-02 rather than inferred:
//   * Hiring-Radar's baidu parser emits `/jobs/social-detail/{uuid}` — the
//     server 302s it to `https://talent.baidu.com/jobs/404` (page title
//     "百度校园招聘", uuid absent from the HTML). job-pro's adapter emits
//     `/jobs/detail/SOCIAL/{uuid}`, which returns the SSR job page with the
//     uuid present in the markup.
//   * Hiring-Radar's moka parser emits `/social-recruitment/{org}/{siteId}/job/{id}
//     with no fragment — Moka is hash-routed, so that path answers HTTP 404
//     "您访问的页面不存在". job-pro's moka factory emits the same portal as
//     `...{siteId}#/job/{id}`, which a headless browser renders as the JD
//     ("申请职位 / 职位描述 / 岗位职责" text present). Upstream agrees:
//     @ha7ch/job-pro dist/weibo.js documents the no-fragment form as hitting
//     "the tenant's 'page not found' handler at the server level".
// Matching is STRICTLY positive: only URLs that match one of the two malformed
// shapes exactly are rewritten; everything else — including the rows that
// already carry `#/job/` — is returned byte-identical, so a wrong rule cannot
// damage the ~17k links that already work. List-page URLs (no id tail) are left
// alone: there is nothing to move into a fragment.
const BAIDU_SOCIAL_DETAIL_RE = /^(https?:\/\/talent\.baidu\.com)\/jobs\/social-detail\/([0-9a-f][0-9a-f-]{18,36})(?:\?.*)?$/i;
const MOKA_NO_FRAGMENT_RE = /^(https?:\/\/[^/]*mokahr\.com\/[^"]*?)\/(jobs?|positions?)\/([0-9a-zA-Z][0-9a-zA-Z_-]{5,63})$/i;

/**
 * Repair a malformed deep link. Returns the input unchanged when no rule hits.
 * @param {string} url
 * @returns {{url: string, rule: string}}
 */
function normalizeDetailUrl(url) {
  const baidu = url.match(BAIDU_SOCIAL_DETAIL_RE);
  if (baidu) return { url: `${baidu[1]}/jobs/detail/SOCIAL/${baidu[2]}`, rule: 'baidu-social-detail' };
  // A fragment in the input means the row is already hash-routed; the regex
  // cannot match across `#`, but guard anyway so the two forms never stack.
  if (url.includes('#')) return { url, rule: '' };
  const moka = url.match(MOKA_NO_FRAGMENT_RE);
  if (moka) return { url: `${moka[1]}#/${moka[2]}/${moka[3]}`, rule: 'moka-missing-fragment' };
  return { url, rule: '' };
}

function toRecords(rows, opts = {}) {
  const dropCampus = !opts.keepCampus;
  const keepRawUrls = !!opts.keepRawUrls;
  const dropped = { intern: 0, campus: 0 };
  const sample = { intern: [], campus: [] };
  const rewritten = new Map();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const title = String(row.title || row.name || '').trim();
    const url = pickUrl(row);
    if (!title || !url) continue; // career-ops requires both
    if (dropCampus) {
      const verdict = classifyRecruit(row, url);
      if (verdict.kind !== 'open') {
        dropped[verdict.kind]++;
        if (sample[verdict.kind].length < 3) {
          sample[verdict.kind].push(`${title.slice(0, 32)}[${verdict.evidence}]`);
        }
        continue;
      }
    }
    // Normalised AFTER the channel gate on purpose: the gate's drop counts were
    // regression-tested against the raw cache URLs, and rewriting a baidu tail
    // injects the token `SOCIAL` into the URL, which would change what the gate
    // sees. Output-side repair, gate-side stays comparable run to run.
    const link = keepRawUrls ? { url, rule: '' } : normalizeDetailUrl(url);
    if (link.rule) {
      rewritten.set(link.rule, (rewritten.get(link.rule) || 0) + 1);
    }
    const rec = {
      title,
      url: link.url,
      company: String(row.company || '').trim(),
      location: normalizeLocation(row.location || row.locations || ''),
    };
    // cn_bridge enriches job-pro rows with a combined description already; the
    // join fallback also accepts caches that store description and requirements
    // as SEPARATE fields (e.g. from a future producer) so the reader never
    // silently drops the 任职要求 half of a JD.
    const description = row.description || row.jd;
    const requirements = row.requirements;
    let jd = '';
    if (typeof description === 'string' && description.trim()) {
      jd = description;
      if (typeof requirements === 'string' && requirements.trim() && !jd.includes(requirements.trim())) {
        jd = `${jd}\n\n【任职要求】\n${requirements}`;
      }
    } else if (typeof requirements === 'string' && requirements.trim()) {
      jd = `【任职要求】\n${requirements}`;
    }
    if (jd) rec.description = jd;
    const postedAt = firstPostedAt(row);
    if (postedAt !== undefined) rec.postedAt = postedAt;
    // 漏洞一修正（上半）：scan's buildPostingAgeFilter deliberately passes rows
    // whose postedAt is not a number (an unknown date is not evidence of
    // staleness), so job-pro rows — a source that carries NO date field at all
    // — slipped through the 15-day window unfiltered. We cannot invent a date
    // here, but we can stop pretending: `_dated:false` makes the gap explicit
    // for the funnel scripts and for triage, which must treat those rows as
    // 时效未验证 (liveness + page-date evidence required) instead of fresh.
    rec._dated = postedAt !== undefined;
    // Light provenance for the pipeline note without polluting the
    // provider's expected fields (extra keys are ignored by local-parser).
    if (row.source) rec._source = row.source;
    out.push(rec);
  }
  if (dropCampus && (dropped.intern || dropped.campus)) {
    for (const kind of ['intern', 'campus']) {
      log(`cn_cache_reader: ${kind} gate dropped ${dropped[kind]} row(s); e.g. ${sample[kind].join(' | ')}`);
    }
  }
  for (const [rule, n] of rewritten) {
    log(`cn_cache_reader: url rule "${rule}" rewrote ${n} row(s)`);
  }
  if (keepRawUrls) log('cn_cache_reader: --keep-raw-urls — URL normalisation skipped');
  return out;
}

function main() {
  let records = [];
  try {
    const cachePath = resolveCachePath();
    if (!existsSync(cachePath)) {
      log(`cn_cache_reader: cache not found at ${cachePath} — emitting []`);
    } else {
      const parsed = JSON.parse(readFileSync(cachePath, 'utf-8'));
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.jobs) ? parsed.jobs
        : Array.isArray(parsed?.results) ? parsed.results
        : null;
      if (!rows) {
        log('cn_cache_reader: cache JSON is not an array/jobs[]/results[] — emitting []');
      } else {
        records = toRecords(rows, {
          keepCampus: process.argv.includes('--keep-campus'),
          keepRawUrls: process.argv.includes('--keep-raw-urls'),
        });
        log(`cn_cache_reader: ${records.length} row(s) from ${cachePath}`);
      }
    }
  } catch (err) {
    // Never let an error reach stdout — scan must still get valid JSON.
    log(`cn_cache_reader error: ${err && err.message}`);
    records = [];
  }
  // stdout is ONLY ever this one JSON array.
  process.stdout.write(JSON.stringify(records));
}

main();
