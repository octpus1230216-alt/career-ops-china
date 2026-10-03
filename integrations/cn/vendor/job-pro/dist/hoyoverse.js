// HoYoverse careers adapter — SmartRecruiters public postings API.
//
// ============================================================
// Migration note (probed 2026-07-11):
//
//   HoYoverse (miHoYo's international brand) moved its public job board off
//   Greenhouse and onto SmartRecruiters. The old Greenhouse board
//   (boards-api.greenhouse.io/v1/boards/hoyoverse/jobs) still answers
//   HTTP 200 but is permanently empty ({"jobs":[],"meta":{"total":0}}),
//   which made this adapter silently report "0 open positions" while the
//   real board had 11 live postings. Do NOT resurrect the Greenhouse slug.
//
//   Live endpoints (all GET, JSON, no auth — verified with curl 2026-07-11):
//
//     GET https://api.smartrecruiters.com/v1/companies/HoYoverse/postings
//       ?q=<keyword>&limit=<1..100>&offset=<n>
//       → { offset, limit, totalFound, content: [ ...postings ] }
//       * `q` is SERVER-SIDE full-text search over title + job-ad body
//         (verified: q=programmer → totalFound:2; q=engineer → totalFound:3,
//         including "Senior Combat Designer" whose JD mentions Engineers).
//       * `limit` is server-capped at 100 (requesting limit=200 echoes
//         limit:100), so pageSize is clamped to 100 here.
//       * `offset` paginates (verified: limit=5&offset=5 returns rows 6-10
//         of totalFound:11).
//
//     GET https://api.smartrecruiters.com/v1/companies/HoYoverse/postings/<id>
//       → full posting incl. jobAd.sections {companyDescription,
//         jobDescription, qualifications, additionalInformation} (HTML),
//         postingUrl, applyUrl. Unknown id → clean HTTP 404
//         {"code":"RESOURCE_NOT_FOUND"}.
//
//   Company identifier: `HoYoverse` (case-sensitive path segment; confirmed
//   by company.identifier in every posting).
//
//   Human board: https://careers.smartrecruiters.com/HoYoverse (11 postings
//   as of 2026-07-11). Per-posting page https://jobs.smartrecruiters.com/
//   HoYoverse/<id> answers HTTP 200 without the SEO name-slug suffix
//   (verified with curl), so list rows can construct apply_url from id alone.
//
//   The board is international experienced-hire only (LA / Montréal /
//   Singapore, English postings) — scope stays ["social", "all"], same
//   convention as the Greenhouse-family boards. China-side campus hiring
//   lives at campus.mihoyo.com (see the `mihoyo` adapter).
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
const API_ROOT = "https://api.smartrecruiters.com/v1/companies/HoYoverse/postings";
const SOURCE = "api.smartrecruiters.com/HoYoverse";
const BOARD_URL = "https://careers.smartrecruiters.com/HoYoverse";
const POSTING_URL_BASE = "https://jobs.smartrecruiters.com/HoYoverse";
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json",
};
/** Server-side cap on `limit` (probed: limit=200 → server echoes limit:100). */
const MAX_PAGE_SIZE = 100;
export const supportedScopes = ["social", "all"];
function formatLocation(loc) {
    if (!loc)
        return "";
    const base = loc.fullLocation ??
        [loc.city, loc.region, loc.country].filter(Boolean).join(", ");
    return loc.remote ? (base ? `${base} (Remote)` : "Remote") : base;
}
function summarize(p) {
    const id = String(p.id ?? "");
    return {
        post_id: id,
        title: p.name ?? "",
        project: p.function?.label ?? p.department?.label ?? "",
        recruit_label: [p.typeOfEmployment?.label, p.experienceLevel?.label]
            .filter(Boolean)
            .join(" · ") || "",
        bgs: "",
        work_cities: formatLocation(p.location),
        // Verified: jobs.smartrecruiters.com/HoYoverse/<id> answers HTTP 200
        // without the SEO name-slug suffix.
        apply_url: `${POSTING_URL_BASE}/${id}`,
    };
}
// ---------- HTTP with backoff ----------
/**
 * GET with one retry on 429/5xx (SmartRecruiters' public API rate-limits
 * bursts). Never hammers: single 1.2s backoff, then gives up cleanly.
 */
async function getJson(url) {
    for (let attempt = 0;; attempt++) {
        let response;
        try {
            response = await fetch(url, { headers: HEADERS });
        }
        catch (err) {
            return {
                ok: false,
                message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if ((response.status === 429 || response.status >= 500) &&
            attempt === 0) {
            await new Promise((r) => setTimeout(r, 1200));
            continue;
        }
        if (!response.ok) {
            return { ok: false, message: `HTTP ${response.status}: ${response.statusText}` };
        }
        try {
            return { ok: true, data: (await response.json()) };
        }
        catch (err) {
            return {
                ok: false,
                message: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}
async function fetchPage(opts) {
    const params = new URLSearchParams();
    const kw = (opts.keyword ?? "").trim();
    if (kw)
        params.set("q", kw);
    params.set("limit", String(opts.limit));
    params.set("offset", String(opts.offset));
    const res = await getJson(`${API_ROOT}?${params}`);
    if (!res.ok)
        return res;
    return {
        ok: true,
        totalFound: res.data.totalFound ?? 0,
        content: res.data.content ?? [],
    };
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const keyword = (opts.keyword ?? "").trim();
    const res = await fetchPage({
        keyword,
        limit: pageSize,
        offset: (page - 1) * pageSize,
    });
    if (!res.ok) {
        return {
            ok: false,
            message: res.message,
            source: SOURCE,
            apply_url: BOARD_URL,
            positions: [],
        };
    }
    return {
        ok: true,
        source: SOURCE,
        scope: opts.scope,
        query: { keyword, page, pageSize, scope: opts.scope },
        page,
        page_size: pageSize,
        // Server-side totalFound is already keyword-filtered (q is upstream),
        // so `total` is the true number of matches, never the page length.
        total: res.totalFound,
        positions: res.content.map(summarize),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const keyword = (opts.keyword ?? "").trim();
    const maxPages = Math.max(1, Math.min(100, opts.maxPages ?? 20));
    const seen = new Set();
    const positions = [];
    let totalFound = 0;
    let truncated = false;
    let offset = 0;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
        const res = await fetchPage({ keyword, limit: MAX_PAGE_SIZE, offset });
        if (!res.ok) {
            if (positions.length === 0) {
                return {
                    ok: false,
                    message: res.message,
                    source: SOURCE,
                    apply_url: BOARD_URL,
                    fetched: 0,
                    positions: [],
                };
            }
            // Partial enumeration survived; surface what we have, marked truncated.
            truncated = true;
            break;
        }
        totalFound = res.totalFound;
        let added = 0;
        for (const p of res.content) {
            const id = String(p.id ?? "");
            if (!id || seen.has(id))
                continue; // dedupe by post_id
            seen.add(id);
            positions.push(summarize(p));
            added++;
        }
        offset += res.content.length;
        // Stop on: exhausted total, short page, or a page that added nothing new.
        if (positions.length >= totalFound)
            break;
        if (res.content.length < MAX_PAGE_SIZE)
            break;
        if (added === 0)
            break;
        if (pageNo === maxPages - 1)
            truncated = true;
    }
    return {
        ok: true,
        source: SOURCE,
        scope: opts.scope,
        total: totalFound,
        fetched: positions.length,
        truncated,
        positions,
    };
}
// ---------- fetchPositionDetail ----------
/** Order in which jobAd sections are stitched into `description`. */
const SECTION_ORDER = [
    "companyDescription",
    "jobDescription",
    "qualifications",
    "additionalInformation",
];
function htmlToText(html) {
    return html
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id) {
        return { ok: false, source: SOURCE, message: "post_id is required" };
    }
    const res = await getJson(`${API_ROOT}/${encodeURIComponent(id)}`);
    if (!res.ok) {
        return { ok: false, source: SOURCE, post_id: id, message: res.message };
    }
    const posting = res.data;
    const sections = posting.jobAd?.sections ?? {};
    const parts = [];
    for (const key of SECTION_ORDER) {
        const sec = sections[key];
        if (!sec)
            continue;
        const text = htmlToText(sec.text ?? "");
        if (!text)
            continue;
        const title = (sec.title ?? "").trim();
        parts.push(title ? `${title}: ${text}` : text);
    }
    const description = parts.join("\n\n");
    if (!description) {
        return {
            ok: false,
            source: SOURCE,
            post_id: id,
            message: "posting exists but its job ad has no readable sections",
        };
    }
    const summary = summarize(posting);
    return {
        ok: true,
        source: SOURCE,
        post_id: id,
        title: posting.name ?? "",
        project: summary.project,
        recruit_label: summary.recruit_label,
        ref_number: posting.refNumber ?? "",
        released_date: posting.releasedDate ?? "",
        description,
        work_cities: summary.work_cities,
        apply_url: posting.postingUrl ?? posting.applyUrl ?? summary.apply_url,
    };
}
// ---------- full-board pool (for dicts / match) ----------
let _poolCache = null;
async function fetchPool() {
    const now = Date.now();
    if (_poolCache && now - _poolCache.fetchedAt < 5 * 60 * 1000) {
        return _poolCache.ok
            ? { ok: true, postings: _poolCache.postings }
            : { ok: false, message: _poolCache.message };
    }
    // Bounded enumeration: the board holds 11 postings (2026-07), far below
    // the 20-page (2000-posting) cap of fetchAllPositions.
    const seen = new Set();
    const postings = [];
    let offset = 0;
    for (let pageNo = 0; pageNo < 20; pageNo++) {
        const res = await fetchPage({ limit: MAX_PAGE_SIZE, offset });
        if (!res.ok) {
            _poolCache = { ok: false, message: res.message, fetchedAt: now };
            return { ok: false, message: res.message };
        }
        let added = 0;
        for (const p of res.content) {
            const id = String(p.id ?? "");
            if (!id || seen.has(id))
                continue;
            seen.add(id);
            postings.push(p);
            added++;
        }
        offset += res.content.length;
        if (postings.length >= res.totalFound ||
            res.content.length < MAX_PAGE_SIZE ||
            added === 0)
            break;
    }
    _poolCache = { ok: true, postings, fetchedAt: now };
    return { ok: true, postings };
}
// ---------- fetchDictionaries ----------
function uniqueSorted(values) {
    return [...new Set(values.filter((v) => Boolean(v)))].sort();
}
export async function fetchDictionaries() {
    const pool = await fetchPool();
    if (!pool.ok) {
        return { ok: false, source: SOURCE, message: pool.message };
    }
    const ps = pool.postings;
    return {
        ok: true,
        source: SOURCE,
        note: "SmartRecruiters has no public dictionary endpoint; values are derived from the live posting list.",
        functions: uniqueSorted(ps.map((p) => p.function?.label)),
        experience_levels: uniqueSorted(ps.map((p) => p.experienceLevel?.label)),
        employment_types: uniqueSorted(ps.map((p) => p.typeOfEmployment?.label)),
        locations: uniqueSorted(ps.map((p) => formatLocation(p.location))),
    };
}
// ---------- notices (stub) ----------
const NOTICES_STUB = {
    ok: false,
    source: SOURCE,
    message: "HoYoverse: SmartRecruiters postings API has no announcements endpoint",
};
export async function listNotices() {
    return NOTICES_STUB;
}
export async function getNotice(_id) {
    return NOTICES_STUB;
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return NOTICES_STUB;
}
// ---------- matchResume ----------
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 20);
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: SOURCE,
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const pool = await fetchPool();
    if (!pool.ok) {
        return { ok: false, source: SOURCE, message: pool.message, positions: [] };
    }
    const scored = [];
    for (const p of pool.postings) {
        const blob = [
            p.name ?? "",
            formatLocation(p.location),
            p.function?.label ?? "",
            p.experienceLevel?.label ?? "",
        ].join(" ");
        const { score, reasons } = scoreOverlap(blob, terms, cities);
        if (score > 0)
            scored.push({ score, raw: p, reasons });
    }
    scored.sort((a, b) => b.score - a.score);
    let shortlist = scored.slice(0, Math.max(topN, candidates));
    if (!shortlist.length) {
        shortlist = pool.postings.slice(0, candidates).map((raw) => ({
            score: 0,
            raw,
            reasons: [],
        }));
    }
    const matches = shortlist.slice(0, topN).map((s) => {
        const mr = s.reasons.length > 0
            ? s.reasons.slice(0, 5)
            : ["no specific keyword overlap — surfaced from full board listing"];
        return { ...summarize(s.raw), match_reasons: mr };
    });
    return {
        ok: true,
        source: SOURCE,
        extracted_terms: terms,
        city_preferences: cities,
        matches,
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
