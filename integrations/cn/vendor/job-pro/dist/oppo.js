// OPPO careers adapter for `job-pro`.
//
// ============================================================
// API DISCOVERY (probed 2026-05-15; social re-probe 2026-05-20)
//
// careers.oppo.com is a Vite SPA whose campus job listing is rendered by the
// dynamically-loaded chunk /assets/js/job-edfe7d6e.js. The chunk exposes two
// candidate routes:
//
//   POST /ats-candidate-api/open-api/position/queryPositionList  → HTTP 404
//   POST /openapi/position/pageNew                                → HTTP 200 ✓
//
// The working route is `/openapi/position/pageNew`. It returns a paginated
// list of all currently-open positions across the OPPO recruiting site without
// any token or signed header — only standard browser headers are required.
// Both campus (校招/应届生) and intern (实习生) postings live on this endpoint;
// the `recruitmentType` field on each record distinguishes them.
//
// Endpoint inventory (all anon, all on careers.oppo.com):
//   POST /openapi/position/pageNew                       → paginated job list
//   GET  /openapi/position/detail?idRecruitPosition=<id> → single posting
//   GET  /openapi/position/project/list                  → recruitment projects
//   GET  /openapi/position/relatedPosition?...           → related jobs
//   GET  /openapi/sec/getRiskReport                      → WAF risk probe
//   GET  /openapi/system/dictionary/queryList            → filter taxonomy
//
// ============================================================
// SOCIAL-HIRE STATUS (1.1.0, worktree J)
//
// OPPO has NO public social-hire API on careers.oppo.com.
//
// What was probed (2026-05-20):
//   1. /openapi/position/pageNew with recruitmentType ∈ {Social, Society,
//      Experienced, social, SOCIAL, EXPERIENCED, Recruit, Recruitment,
//      experienced, society} → every variant returns code:0 with total:0.
//   2. /openapi/position/project/list enumerates the entire upstream project
//      taxonomy: only "doctor" (博士生), "Graduate" (应届生 校招), and "Intern"
//      (实习生) project types exist. There is no社招 / Experienced project.
//   3. /openapi/position/queryList → HTTP 404 (legacy route, never existed).
//   4. /api/recruit/social/list → HTTP 500 from a generic Spring controller
//      (catch-all error, not a real route).
//   5. career.oppo.com (separate subdomain, HTTP 200) is the applicant flow
//      site — login, resume edit, delivery tracking — and exposes
//      /api/delivery/*, /api/system/user/*, /api/careerObjective/*, but NO
//      position-search endpoint. Its bundle does not reference openapi/.
//   6. social.oppo.com / hr.oppo.com / jobs.oppo.com / recruit.oppo.com /
//      experienced.oppo.com / careers-social.oppo.com / experience.oppo.com
//      → all DNS-fail (no SSL handshake). These subdomains do not exist.
//
// Conclusion: OPPO routes社招/social hires through external channels (Liepin,
// BOSS, WeChat referrals) — same posture as Tencent / JD on this axis.
// Declare supportedScopes:["campus","intern","all"]. The dispatcher rejects
// --scope social at the entry boundary with a useful message.
// ============================================================
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
/**
 * OPPO supports campus + intern + all (1.1.0+).
 *
 * Scope translation (re-verified 2026-07-11):
 *   campus → recruitmentType:"Graduate" + "doctor"  (two upstream requests,
 *            merged client-side — the 博士生 campus project counts as 校招;
 *            upstream recruitmentType only accepts a single String: an array
 *            body → Jackson 500, recruitmentTypeList/recruitmentTypes are
 *            silently ignored, "Graduate,doctor" → total 0)
 *   intern → recruitmentType:"Intern"
 *   all / undefined → no recruitmentType filter (mixed feed)
 *
 * `--scope social` is rejected by the dispatcher (see supportedScopes below).
 * OPPO has no public social-hire API — see the API DISCOVERY block above.
 */
export const supportedScopes = ["campus", "intern", "all"];
const SOURCE = "careers.oppo.com";
const API_ROOT = "https://careers.oppo.com";
const SITE_ROOT = "https://careers.oppo.com/";
const DETAIL_PAGE = (id) => `https://careers.oppo.com/#/campus/talent/positionDetail/${encodeURIComponent(id)}`;
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: SITE_ROOT,
    Origin: "https://careers.oppo.com",
};
async function call(method, path, opts = {}) {
    let url = `${API_ROOT}${path}`;
    if (opts.query) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(opts.query)) {
            if (v !== undefined)
                params.set(k, String(v));
        }
        const qs = params.toString();
        if (qs)
            url += (path.includes("?") ? "&" : "?") + qs;
    }
    const headers = { ...DEFAULT_HEADERS };
    let body;
    if (opts.body !== undefined) {
        body = JSON.stringify(opts.body);
        headers["Content-Type"] = "application/json;charset=UTF-8";
    }
    let response;
    try {
        response = await fetch(url, { method, headers, body });
    }
    catch (err) {
        return {
            ok: false,
            message: `network error: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    if (!response.ok) {
        return { ok: false, message: `HTTP ${response.status}: ${response.statusText}` };
    }
    let payload;
    try {
        payload = (await response.json());
    }
    catch (err) {
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : err}` };
    }
    return {
        ok: payload.code === 0,
        data: payload.data,
        message: payload.msg || (payload.code === 0 ? "ok" : "upstream error"),
    };
}
/** Upstream recruitmentType values that make up the campus (校招) scope.
 *  "Graduate" = 应届生 formal campus hire, "doctor" = 博士生 campus project
 *  (2026-07-11: the mixed feed of 123 splits Intern:98 + doctor:25; Graduate
 *  is 0 between hiring seasons — the 博士生 postings ARE the live campus jobs). */
const CAMPUS_RECRUITMENT_TYPES = ["Graduate", "doctor"];
/**
 * Translate the CLI scope to the upstream `recruitmentType` values.
 * Returns `undefined` to mean "do not send the filter" (i.e. mixed feed).
 * A multi-element result means one upstream request per type, merged
 * client-side — recruitmentType is a single Java String upstream (array →
 * Jackson 500; recruitmentTypeList / comma-joined → ignored / 0; verified
 * 2026-07-11 by direct POSTs to /openapi/position/pageNew).
 */
function recruitmentTypesForScope(s) {
    // OPPO's upstream taxonomy uses "Graduate" for 应届生/校招 (not "Campus" —
    // that string returns 0 results despite looking right). Verified 2026-05
    // via /openapi/position/project/list; "doctor" added 2026-07 so the 博士生
    // campus project is not silently excluded from --scope campus.
    if (s === "campus")
        return CAMPUS_RECRUITMENT_TYPES;
    if (s === "intern")
        return ["Intern"];
    // "all" → no filter, mixed feed. "social" never reaches here (dispatcher
    // rejects it via supportedScopes). undefined preserves 1.0.93 behaviour
    // (caller's existing `recruitType` field wins).
    return undefined;
}
function summarize(item) {
    const id = String(item.idRecruitPosition ?? item.idProjPosition ?? item.projectPositionId ?? "");
    return {
        post_id: id,
        title: (item.positionName ?? item.projectPositionName ?? "").trim(),
        project: (item.projectName ?? "").trim(),
        recruit_label: (item.recruitmentTypeName ?? item.recruitmentType ?? "").trim(),
        bgs: (item.positionTypeName ?? "").trim(),
        work_cities: (item.workCityName ?? "").trim(),
        apply_url: id ? DETAIL_PAGE(id) : SITE_ROOT,
    };
}
function feedBody(filter, pageNum, pageSize) {
    const body = { pageNum, pageSize };
    if (filter.positionName)
        body.positionName = filter.positionName;
    if (filter.recruitmentType)
        body.recruitmentType = filter.recruitmentType;
    if (filter.workCityCode)
        body.workCityCode = filter.workCityCode;
    return body;
}
async function fetchPage(body) {
    const r = await call("POST", "/openapi/position/pageNew", { body });
    if (!r.ok || !r.data)
        return { ok: false, message: r.message };
    const rows = r.data.records ?? [];
    return { ok: true, message: "ok", rows, total: r.data.total ?? rows.length };
}
/**
 * Exhaustively page through ONE upstream feed (a single recruitmentType or
 * the unfiltered mixed feed), deduping by post_id. Stops on: fetched >= the
 * upstream total, a short page, or a page contributing no new ids. pageNum
 * paginates for real on this endpoint (page 1 vs 2 return disjoint ids;
 * verified 2026-07-11).
 */
async function enumerateFeed(filter, opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 50));
    const maxPages = Math.max(1, opts.maxPages ?? 40);
    const seen = new Set();
    const positions = [];
    let total = 0;
    for (let page = 1; page <= maxPages; page++) {
        const r = await fetchPage(feedBody(filter, page, pageSize));
        if (!r.ok) {
            return { ok: false, message: r.message, total, positions, truncated: positions.length < total };
        }
        total = r.total;
        let added = 0;
        for (const row of r.rows) {
            const s = summarize(row);
            if (!s.post_id || seen.has(s.post_id))
                continue;
            seen.add(s.post_id);
            positions.push(s);
            added++;
        }
        if (positions.length >= total)
            break; // exhausted the feed
        if (r.rows.length < pageSize)
            break; // short page → server has no more
        if (added === 0)
            break; // page repeated known ids → stop instead of looping
    }
    return {
        ok: true,
        message: "ok",
        total,
        positions,
        truncated: positions.length < total,
    };
}
/** Resolve the effective recruitmentType list: `--scope` wins over the legacy
 *  per-adapter `recruitType` field; both map campus → Graduate + doctor. */
function resolveRecruitmentTypes(scope, recruitType) {
    const fromScope = recruitmentTypesForScope(scope);
    if (fromScope !== undefined)
        return fromScope;
    if (recruitType === "campus")
        return CAMPUS_RECRUITMENT_TYPES;
    if (recruitType === "intern")
        return ["Intern"];
    return undefined;
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const keyword = opts.keyword?.trim().slice(0, 60) || undefined;
    const types = resolveRecruitmentTypes(opts.scope, opts.recruitType);
    // Single upstream feed (no filter, intern, or a one-type scope): let the
    // server paginate — pageNum/pageSize/positionName all work server-side.
    if (!types || types.length === 1) {
        const body = feedBody({ recruitmentType: types?.[0], positionName: keyword, workCityCode: opts.cityCode }, page, pageSize);
        const r = await fetchPage(body);
        if (!r.ok) {
            return {
                ok: false,
                source: SOURCE,
                message: r.message,
                query: body,
                positions: [],
            };
        }
        return {
            ok: true,
            source: SOURCE,
            query: body,
            page,
            page_size: pageSize,
            total: r.total,
            positions: r.rows.map(summarize),
        };
    }
    // Multi-type scope (campus = Graduate + doctor): upstream recruitmentType
    // only takes a single String (array → Jackson 500; recruitmentTypeList /
    // "Graduate,doctor" → ignored / 0; verified 2026-07-11), so run one
    // server-filtered enumeration per type and merge + paginate client-side.
    // Bounded: the whole site is ~123 postings, so 20 pages × 100 per type is
    // ample headroom.
    const query = {
        pageNum: page,
        pageSize,
        recruitmentTypes: [...types],
    };
    if (keyword)
        query.positionName = keyword;
    if (opts.cityCode)
        query.workCityCode = opts.cityCode;
    const merged = [];
    const seen = new Set();
    let truncated = false;
    for (const t of types) {
        const feed = await enumerateFeed({ recruitmentType: t, positionName: keyword, workCityCode: opts.cityCode }, { pageSize: 100, maxPages: 20 });
        if (!feed.ok) {
            return {
                ok: false,
                source: SOURCE,
                message: feed.message,
                query,
                positions: [],
            };
        }
        truncated = truncated || feed.truncated;
        for (const p of feed.positions) {
            if (seen.has(p.post_id))
                continue;
            seen.add(p.post_id);
            merged.push(p);
        }
    }
    const start = (page - 1) * pageSize;
    return {
        ok: true,
        source: SOURCE,
        query,
        page,
        page_size: pageSize,
        total: merged.length,
        truncated,
        positions: merged.slice(start, start + pageSize),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 50));
    const maxPages = Math.max(1, opts.maxPages ?? 40);
    const keyword = opts.keyword?.trim().slice(0, 60) || undefined;
    const types = resolveRecruitmentTypes(opts.scope, opts.recruitType);
    // One enumeration per upstream feed: [undefined] = the mixed feed;
    // campus = Graduate + doctor (see recruitmentTypesForScope).
    const feeds = types ?? [undefined];
    const merged = [];
    const seen = new Set();
    let total = 0;
    let truncated = false;
    for (const t of feeds) {
        const feed = await enumerateFeed({ recruitmentType: t, positionName: keyword }, { pageSize, maxPages });
        if (!feed.ok) {
            return {
                ok: false,
                source: SOURCE,
                message: feed.message,
                total: 0,
                fetched: merged.length,
                positions: merged,
            };
        }
        total += feed.total; // per-feed upstream totals; feeds are disjoint by type
        truncated = truncated || feed.truncated;
        for (const p of feed.positions) {
            if (seen.has(p.post_id))
                continue;
            seen.add(p.post_id);
            merged.push(p);
        }
    }
    return {
        ok: true,
        source: SOURCE,
        total,
        fetched: merged.length,
        truncated,
        positions: merged,
    };
}
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id)
        return { ok: false, source: SOURCE, message: "post_id is required", post_id: id };
    // The endpoint expects `id`, not `idRecruitPosition` — passing
    // `idRecruitPosition` returns the puzzling "id不能为空" error even when the
    // value is present. The response body still keys the id back as
    // `idRecruitPosition`, which is what tripped this in the first place.
    const r = await call("GET", "/openapi/position/detail", {
        query: { id },
    });
    if (!r.ok || !r.data) {
        return { ok: false, source: SOURCE, message: r.message || "no detail returned", post_id: id };
    }
    const raw = r.data;
    // Detail responses null out the flat workCityName/workCityCode fields and
    // put the real cities in workCityVOList instead (verified 2026-07-11 on
    // id=1724: workCityName:null, workCityVOList:[深圳市, 成都市] — while the
    // list row for the same posting carries workCityName:"成都市,深圳市").
    // Join the VO list to match the list-row format when the flat fields are
    // empty.
    const cityVOs = Array.isArray(raw.workCityVOList) ? raw.workCityVOList : [];
    const work_city = (raw.workCityName ?? "").trim() ||
        cityVOs.map((c) => (c?.workCityName ?? "").trim()).filter(Boolean).join(",");
    const work_city_code = (raw.workCityCode ?? "").trim() ||
        cityVOs.map((c) => (c?.workCityCode ?? "").trim()).filter(Boolean).join(",");
    return {
        ok: true,
        source: SOURCE,
        post_id: String(raw.idRecruitPosition ?? id),
        title: raw.positionName ?? raw.projectPositionName ?? "",
        project: raw.projectName ?? "",
        recruit_label: raw.recruitmentTypeName ?? raw.recruitmentType ?? "",
        position_type: raw.positionTypeName ?? "",
        description: (raw.positionDesc ?? raw.projectPositionDesc ?? "").trim(),
        requirements: (raw.positionRequire ?? raw.projectPositionRequire ?? "").trim(),
        work_city,
        work_city_code,
        head_count: raw.positionNum,
        release_time: raw.releaseTime ?? "",
        apply_url: DETAIL_PAGE(id),
    };
}
// ---------- fetchDictionaries ----------
export async function fetchDictionaries() {
    const r = await call("GET", "/openapi/system/dictionary/queryList");
    if (!r.ok)
        return { ok: false, source: SOURCE, message: r.message };
    return {
        ok: true,
        source: SOURCE,
        api_host: API_ROOT,
        verified_at: new Date().toISOString(),
        dictionaries: r.data,
    };
}
// ---------- notices (not exposed publicly) ----------
const NO_NOTICES = "OPPO careers does not expose a public notices/announcements endpoint.";
export async function listNotices() {
    return { ok: false, source: SOURCE, message: NO_NOTICES, notices: [] };
}
export async function getNotice(noticeId) {
    return { ok: false, source: SOURCE, message: NO_NOTICES, notice_id: noticeId };
}
export async function findNoticesByQuestion(question, _opts = {}) {
    return { ok: false, source: SOURCE, question, message: NO_NOTICES, matches: [] };
}
// ---------- matchResume ----------
export async function matchResume(text, opts = {}) {
    const { terms, cities } = extractResumeSignals(text ?? "");
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 200);
    const all = await fetchAllPositions({
        pageSize: 50,
        maxPages: Math.ceil(candidates / 50),
        scope: opts.scope,
    });
    if (!all.ok) {
        return {
            ok: false,
            source: SOURCE,
            message: all.message,
            extracted_terms: terms,
            city_preferences: cities,
            matches: [],
        };
    }
    const scored = [];
    for (const p of all.positions) {
        const haystack = `${p.title} ${p.project} ${p.bgs} ${p.work_cities}`;
        const score = scoreOverlap(haystack, terms, cities).score;
        if (score > 0)
            scored.push({ score, position: p });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
        ok: true,
        source: SOURCE,
        extracted_terms: terms,
        city_preferences: cities,
        candidate_pool: all.positions.length,
        matches: scored.slice(0, topN).map((s) => s.position),
    };
}
export { extractResumeSignals, scoreOverlap };
