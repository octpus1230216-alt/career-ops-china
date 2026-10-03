// Thin client for Xiaomi's public campus-recruiting API.
//
// Xiaomi does NOT use jobs.bytedance.com or xiaomi.jobs.feishu.cn.
// It self-hosts the ByteDance ATSX (飞书招聘) platform at:
//
//   https://xiaomi.jobs.f.mioffice.cn/   (mioffice.cn = Xiaomi's Feishu fork)
//
// The API shape is IDENTICAL to jobs.bytedance.com:
//   POST /api/v1/search/job/posts
//   GET  /api/v1/config/job/filters/{path}
//
// The key difference: Xiaomi requires three portal-scoping headers to switch
// between campus (校招) and internship (实习) pools:
//   portal-channel:  "campus" | "internship"
//   portal-platform: "pc"
//   website-path:    "campus" | "internship"
//
// Without those headers the API defaults to 社招 (experienced/social hire).
//
// ============================================================
// Endpoint inventory (probed 2026-05, API identical to ByteDance ATSX):
//
//   POST https://xiaomi.jobs.f.mioffice.cn/api/v1/search/job/posts
//        Payload: { keyword, limit, offset, portal_type:3, portal_entrance:1,
//                   language:"zh", recruitment_id_list?, job_function_id_list?,
//                   location_code_list?, subject_id_list? }
//        Response: { code:0, data:{ job_post_list:[...], count:<int> }, message:"ok" }
//
//   GET  https://xiaomi.jobs.f.mioffice.cn/api/v1/job/posts/{post_id}
//        Per-post detail (probed 2026-07). CHANNEL-AGNOSTIC: resolves ids from
//        ALL three pools (campus / internship / social) with just the
//        portal-platform:pc header — no portal-channel needed (verified with a
//        live id from each pool). Response:
//          { code:0, data:{ job_post_detail:{ id,title,description,requirement,
//            recruit_type,city_list,publish_time,code,... },
//            recommend_job_post_List:[...] }, message:"ok" }
//        Unknown/bogus ids still return code:0 but with job_post_detail ABSENT
//        (data carries only recommend_job_post_List:[]) — that is the
//        authoritative not-found signal.
//
//   GET  https://xiaomi.jobs.f.mioffice.cn/api/v1/config/job/filters/campus
//        Returns: { job_function_list, city_list, recruitment_type_list,
//                   job_subject_list, ... }
//
// ============================================================
// Portal pools (controlled by headers, confirmed 2026-05):
//
//   portal-channel: "campus"     → 357 posts  (正式 / new-grad, 招聘类型=校招)
//   portal-channel: "internship" → 729 posts  (实习 / intern,   招聘类型=校招)
//   no channel header            → 2681 posts (社招 / experienced, NOT campus)
//
// ============================================================
// Filter taxonomy (from GET /api/v1/config/job/filters/campus, portal-channel: campus):
//
// DIMENSION 1 — job_function_id_list (职能类别)
//   7178759516879405165 = 软件研发类 / Software R&D
//   7178830559051874412 = 硬件研发类 / Hardware R&D
//   7467761476330340460 = 算法类 / Algorithm
//   7542849286137479277 = 芯片类 / Chip
//   7467761529010634860 = 测试类 / Testing
//   7467761246949179500 = 运维类 / Maintenance
//   7178035552473448557 = 产品类 / Product
//   7178035552473464941 = 设计类 / Design
//   7178830559051858028 = 外语外派类 / Global Expatriate
//   7178759516879388781 = 服务类 / Service
//   7178035552473481325 = 运营类 / Operation
//   7178035552473497709 = 市场类 / Marketing
//   7178035552473514093 = 职能类 / Corporate Function
//   7178035552473530477 = 供应链类 / Supply Chain
//   7493065498218479788 = 汽车工程类 / Automotive Engineering
//   7493065498218496172 = 汽车销售类 / Automotive Sales
//   7493065498218512556 = 汽车服务类 / Automotive Service
//   7493065498218528940 = 数据类 / Data
//
// DIMENSION 2 — location_code_list (工作地点, city codes — 56 cities total)
//   CT_11=北京 CT_125=上海 CT_128=深圳 CT_154=武汉 CT_107=南京 CT_155=西安
//   CT_163=新加坡 CT_199=苏州 CT_66=济南 CT_25=大连 (+46 more)
//
// DIMENSION 3 — recruitment_id_list (campus pool filters)
//   "201" = 正式 (new-grad, matches default campus tab)
//   "202" = 实习 (intern — use portal-channel: internship for this pool)
//
// DIMENSION 4 — job_subject_list (special programs, campus pool, 2 active 2026-05)
//   "7532449299457327213" = 2026届境外校招计划  (overseas campus)
//   "7603687083995121983" = 2026届春季校招计划  (spring campus)
//
// ============================================================
// Detail page URLs (both return HTTP 200):
//   campus:     https://xiaomi.jobs.f.mioffice.cn/campus/position/${id}/detail
//   internship: https://xiaomi.jobs.f.mioffice.cn/internship/position/${id}/detail
//
// ============================================================
// Feishu/ATSX platform note:
//   Xiaomi uses its own Feishu fork (mioffice.cn) running ByteDance's ATSX
//   recruiting backend. The API is STRUCTURALLY IDENTICAL to jobs.bytedance.com —
//   same POST body shape, same response envelope (code/data/message), same field
//   names, same city codes (CT_xx). The ONLY differences are:
//     1. Domain: *.f.mioffice.cn instead of jobs.bytedance.com
//     2. Portal scoping via portal-channel / website-path headers
//   Any future company on Feishu Recruiting (feishu.cn/jobs.*.feishu.cn or
//   *.jobs.f.mioffice.cn) can be adapted from this file with ~10 lines of change.
//
// ============================================================
// ---- PositionSummary field mapping (Xiaomi → canonical) ----
//   post_id       ← item.id  (stringified)
//   title         ← item.title
//   project       ← item.job_function.name  (职能类别; job_category is null in campus)
//   recruit_label ← item.recruit_type.name  (e.g. "正式" / "实习")
//   bgs           ← ""  (not exposed in public search)
//   work_cities   ← item.city_info.name + city_list joined with " / " for multi-city
//   apply_url     ← https://xiaomi.jobs.f.mioffice.cn/campus/position/${id}/detail
import { extractResumeSignals, scoreOverlap, checkResume, pickDistinctiveTerms } from "./tencent.js";
export { checkResume };
/** Recruit scopes Xiaomi can serve.
 *  Xiaomi's Feishu fork (xiaomi.jobs.f.mioffice.cn) exposes three pools via the
 *  portal-channel header (see header comment for post counts):
 *    no header           → ~2533 社招 (social/experienced)
 *    portal-channel:campus     → ~357  正式 (campus / new-grad)
 *    portal-channel:internship → ~729  实习 (intern)
 *  Scope mapping:
 *    social → omit portal-channel header entirely
 *    campus → portal-channel: campus
 *    intern → portal-channel: internship
 *    all    → caller's choice (defaults to campus for back-compat) */
export const supportedScopes = ["social", "campus", "intern", "all"];
/** Map canonical scope → internal channel. Pass scope=undefined to preserve
 *  the historical campus default. */
function channelForScope(scope) {
    if (scope === "social")
        return "social";
    if (scope === "intern")
        return "internship";
    if (scope === "campus")
        return "campus";
    // scope=all and scope=undefined → preserve historical default (campus).
    return undefined;
}
const API_ROOT = "https://xiaomi.jobs.f.mioffice.cn/api/v1";
const CAMPUS_PAGE = "https://xiaomi.jobs.f.mioffice.cn/campus/";
const INTERN_PAGE = "https://xiaomi.jobs.f.mioffice.cn/internship/";
const CAMPUS_DETAIL = (id) => `https://xiaomi.jobs.f.mioffice.cn/campus/position/${encodeURIComponent(id)}/detail`;
const INTERN_DETAIL = (id) => `https://xiaomi.jobs.f.mioffice.cn/internship/position/${encodeURIComponent(id)}/detail`;
function makeHeaders(channel) {
    const base = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "portal-platform": "pc",
    };
    // scope=social → OMIT portal-channel + website-path. Without those headers
    // the API defaults to the ~2533-post 社招 pool.
    if (channel === "social") {
        base.Referer = `https://xiaomi.jobs.f.mioffice.cn/`;
        return base;
    }
    base["portal-channel"] = channel;
    base["website-path"] = channel;
    base.Referer = channel === "campus" ? CAMPUS_PAGE : INTERN_PAGE;
    return base;
}
async function call(path, body, channel = "campus") {
    const url = `${API_ROOT}${path}`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: makeHeaders(channel),
            body: JSON.stringify(body),
        });
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
        message: payload.message || (payload.code === 0 ? "ok" : "upstream error"),
    };
}
function summarizePosition(item, channel) {
    const id = String(item.id ?? "");
    const cityList = item.city_list ?? [];
    let work_cities;
    if (cityList.length > 1) {
        work_cities = cityList
            .map((c) => c.name ?? "")
            .filter(Boolean)
            .join(" / ");
    }
    else {
        work_cities = item.city_info?.name ?? (cityList[0]?.name ?? "");
    }
    // Xiaomi's campus API returns job_category as null; job_function carries the category name
    const project = item.job_function?.name ?? item.job_category?.name ?? "";
    // Detail page mapping. Social posts have no dedicated portal path on
    // mioffice.cn; the campus detail URL pattern is the documented one, and
    // ATSX renders the post regardless of portal once the id is known.
    let detailFn;
    let listPage;
    if (channel === "internship") {
        detailFn = INTERN_DETAIL;
        listPage = INTERN_PAGE;
    }
    else {
        // "campus" and "social" both fall back to the campus detail prefix.
        detailFn = CAMPUS_DETAIL;
        listPage = CAMPUS_PAGE;
    }
    return {
        post_id: id,
        title: item.title ?? "",
        project,
        recruit_label: item.recruit_type?.name ?? "",
        bgs: "",
        work_cities,
        apply_url: id ? detailFn(id) : listPage,
    };
}
// ---------- searchPositions ----------
// NOTE on keyword semantics (audit 2026-07, upstream behaviour — not a CLI
// bug): the ATSX search matches `keyword` against the FULL JD TEXT, not just
// titles, so e.g. "算法" can surface "资金专员" whose JD mentions 算法. A
// direct curl of POST /api/v1/search/job/posts returns byte-identical totals
// and titles. Likewise the campus pool is locked to recruitment batch 201
// (44 posts as of 2026-07), so campus keyword totals are legitimately small.
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * pageSize;
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    // Explicit channel wins; otherwise derive from canonical scope; otherwise
    // preserve historical campus default.
    const channel = opts.channel ?? channelForScope(opts.scope) ?? "campus";
    const asStringList = (v) => {
        if (v === undefined)
            return undefined;
        const arr = Array.isArray(v) ? v : [v];
        return arr.map(String);
    };
    // Default recruitment filter is meaningful only for campus/internship pools.
    // For the social pool we drop the filter so the full ~2533 posts surface.
    const defaultRecruitId = channel === "internship" ? "202" : "201";
    const recruitmentIdList = asStringList(opts.recruitmentIdList) ??
        (channel === "social" ? undefined : [defaultRecruitId]);
    const payload = {
        keyword,
        limit: pageSize,
        offset,
        portal_type: 3,
        portal_entrance: 1,
        language: "zh",
    };
    if (recruitmentIdList && recruitmentIdList.length) {
        payload.recruitment_id_list = recruitmentIdList;
    }
    const jobFunctionIdList = asStringList(opts.jobFunctionIdList);
    if (jobFunctionIdList?.length) {
        payload.job_function_id_list = jobFunctionIdList;
    }
    const cityIdList = asStringList(opts.cityIdList);
    if (cityIdList?.length) {
        payload.location_code_list = cityIdList;
    }
    const subjectIdList = asStringList(opts.subjectIdList);
    if (subjectIdList?.length) {
        payload.subject_id_list = subjectIdList;
    }
    const response = await call("/search/job/posts", payload, channel);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            message: response.message,
            source: "xiaomi.jobs.f.mioffice.cn",
            query: payload,
            positions: [],
        };
    }
    const rows = response.data.job_post_list ?? [];
    return {
        ok: true,
        source: "xiaomi.jobs.f.mioffice.cn",
        query: payload,
        channel,
        page,
        page_size: pageSize,
        total: response.data.count ?? rows.length,
        positions: rows.map((r) => summarizePosition(r, channel)),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 100));
    const maxPages = Math.max(1, opts.maxPages ?? 5);
    const channel = opts.channel ?? channelForScope(opts.scope) ?? "campus";
    const bucket = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
        const result = await searchPositions({ ...opts, page, pageSize, channel });
        if (!result.ok) {
            return {
                ok: false,
                message: result.message,
                source: "xiaomi.jobs.f.mioffice.cn",
                fetched: bucket.length,
                positions: bucket,
            };
        }
        if (total === undefined)
            total = result.total;
        if (!result.positions.length)
            break;
        bucket.push(...result.positions);
        if (total !== undefined && bucket.length >= total)
            break;
    }
    return {
        ok: true,
        source: "xiaomi.jobs.f.mioffice.cn",
        channel,
        total: total ?? bucket.length,
        fetched: bucket.length,
        positions: bucket,
    };
}
// ---------- fetchPositionDetail ----------
// Primary path (probed 2026-07): the per-post REST endpoint
//   GET /api/v1/job/posts/{post_id}
// It is CHANNEL-AGNOSTIC — verified live with one id from each pool (campus
// 7620280811061496102, internship 7660791605549418798, social
// 7303887804843524205): all resolve with just portal-platform:pc, no
// portal-channel header. Bogus ids return code:0 with job_post_detail absent
// (data only has recommend_job_post_List:[]) — the authoritative not-found.
// This fixes the 1.1.14 audit finding where social/intern ids were 100%
// unresolvable: the old implementation paginated ONLY the campus pool with a
// 500-post cap, while the social pool alone is ~2053 posts (2026-07).
//
// Fallback path: if the per-post endpoint fails at transport level
// (WAF/network/non-JSON), sweep the search pagination across ALL THREE
// channels — requested channel first when the caller passed one — with a
// count-driven page limit (hard cap 4000 posts/channel, comfortably above the
// ~2053-post social pool).
/** Channel a post belongs to, inferred from its recruit_type tree:
 *  parent id "1"/社招 → social; id "202"/实习 → internship; else campus
 *  (id "201"/正式, parent "2"/校招). Confirmed live 2026-07 on one post from
 *  each pool. Used only to build the right detail-page apply_url. */
function channelFromRecruitType(rt) {
    if (rt?.parent?.id === "1" || rt?.parent?.name === "社招")
        return "social";
    if (rt?.id === "202" || rt?.name === "实习")
        return "internship";
    return "campus";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** GET the per-post detail endpoint with modest backoff (the WAF answers
 *  rapid-fire requests with empty bodies — observed live 2026-07). Returns
 *  `null` for a clean upstream "no such post" (code:0, job_post_detail
 *  absent) and a string error message for transport-level failures. */
async function fetchDetailById(id) {
    const url = `${API_ROOT}/job/posts/${encodeURIComponent(id)}`;
    // makeHeaders("social") = portal-platform:pc + root Referer, NO
    // portal-channel — exactly the header set the endpoint was probed with.
    const headers = makeHeaders("social");
    let lastErr = "unknown error";
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0)
            await sleep(700 * attempt);
        let response;
        try {
            response = await fetch(url, { headers });
        }
        catch (err) {
            lastErr = `network error: ${err instanceof Error ? err.message : String(err)}`;
            continue;
        }
        if (!response.ok) {
            lastErr = `HTTP ${response.status}: ${response.statusText}`;
            continue;
        }
        let payload;
        try {
            payload = (await response.json());
        }
        catch (err) {
            lastErr = `bad JSON: ${err instanceof Error ? err.message : String(err)}`;
            continue;
        }
        if (payload.code !== 0) {
            lastErr = payload.message || `upstream code ${payload.code}`;
            continue;
        }
        // code:0 envelope is authoritative: detail present → found, absent → no
        // such post anywhere (bogus ids yield {recommend_job_post_List:[]}).
        return payload.data?.job_post_detail ?? null;
    }
    return { transportError: lastErr };
}
/** Fallback: paginate one channel's search pool looking for the id. Page
 *  limit is driven by the pool's own `count` (ceil(count/100)), hard-capped
 *  at 40 pages = 4000 posts — above the ~2053-post social pool (2026-07). */
async function sweepChannelForPost(id, channel) {
    const pageSize = 100;
    const hardCap = 40;
    let maxPages = hardCap;
    const defaultRecruitId = channel === "internship" ? "202" : "201";
    for (let page = 1; page <= maxPages; page++) {
        const payload = {
            keyword: "",
            limit: pageSize,
            offset: (page - 1) * pageSize,
            portal_type: 3,
            portal_entrance: 1,
            language: "zh",
        };
        if (channel !== "social") {
            payload.recruitment_id_list = [defaultRecruitId];
        }
        const response = await call("/search/job/posts", payload, channel);
        if (!response.ok || !response.data)
            break;
        if (page === 1 && typeof response.data.count === "number") {
            maxPages = Math.min(hardCap, Math.max(1, Math.ceil(response.data.count / pageSize)));
        }
        const posts = response.data.job_post_list ?? [];
        const found = posts.find((p) => String(p.id) === id);
        if (found)
            return found;
        if (posts.length < pageSize)
            break;
    }
    return null;
}
export async function fetchPositionDetail(postId, opts = {}) {
    const id = (postId ?? "").trim();
    if (!id) {
        return { ok: false, source: "xiaomi.jobs.f.mioffice.cn", message: "post_id is required" };
    }
    const shape = (found, channel) => {
        const summary = summarizePosition(found, channel);
        return {
            ok: true,
            source: "xiaomi.jobs.f.mioffice.cn",
            post_id: id,
            channel,
            title: found.title ?? "",
            direction: found.sub_title ?? "",
            recruit_label: found.recruit_type?.name ?? "",
            description: found.description ?? "",
            requirements: found.requirement ?? "",
            work_cities: found.city_list ?? (found.city_info ? [found.city_info] : []),
            apply_url: summary.apply_url,
        };
    };
    // 1) Per-post endpoint — resolves ids from every pool in one request.
    const direct = await fetchDetailById(id);
    if (direct && !("transportError" in direct)) {
        return shape(direct, channelFromRecruitType(direct.recruit_type));
    }
    if (direct === null) {
        return {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            post_id: id,
            message: `post ${id} not found (per-post endpoint covers campus/internship/social pools)`,
        };
    }
    // 2) Transport failure → cross-channel pagination sweep. The dispatcher
    // never forwards --scope to detail, so default order covers all pools;
    // an explicitly passed channel/scope is just searched first.
    const preferred = opts.channel ?? channelForScope(opts.scope);
    const channels = ["campus", "internship", "social"];
    if (preferred) {
        channels.splice(channels.indexOf(preferred), 1);
        channels.unshift(preferred);
    }
    for (const channel of channels) {
        const found = await sweepChannelForPost(id, channel);
        if (found)
            return shape(found, channel);
    }
    return {
        ok: false,
        source: "xiaomi.jobs.f.mioffice.cn",
        post_id: id,
        message: `post ${id} not found: per-post endpoint failed (${direct.transportError}) ` +
            `and pagination sweep across campus/internship/social pools had no match`,
    };
}
let _filterCache = null;
export async function fetchDictionaries() {
    if (_filterCache !== null)
        return _filterCache;
    const url = `${API_ROOT}/config/job/filters/campus`;
    let response;
    try {
        response = await fetch(url, { headers: makeHeaders("campus") });
    }
    catch (err) {
        const r = {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            message: `network error: ${err instanceof Error ? err.message : String(err)}`,
        };
        _filterCache = r;
        return r;
    }
    if (!response.ok) {
        const r = {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            message: `HTTP ${response.status}`,
        };
        _filterCache = r;
        return r;
    }
    let payload;
    try {
        payload = await response.json();
    }
    catch (err) {
        const r = {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            message: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
        _filterCache = r;
        return r;
    }
    if (payload.code !== 0 || !payload.data) {
        const r = {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            message: payload.message ?? "upstream error",
        };
        _filterCache = r;
        return r;
    }
    const d = payload.data;
    const jobFunctions = (d.job_function_list ?? []).map((f) => ({
        id: f.id ?? "",
        name: f.name ?? "",
        en_name: f.en_name ?? "",
    }));
    const cities = (d.city_list ?? []).map((c) => ({
        code: c.code ?? "",
        name: c.name ?? "",
        en_name: c.en_name ?? "",
    }));
    const subjects = (d.job_subject_list ?? []).map((s) => ({
        id: s.id ?? "",
        name: s.name?.zh_cn ?? s.name?.i18n ?? "",
    }));
    // Recruitment type list only exposes "校招" (id=2) as the parent.
    // The children 201=正式, 202=实习 are inferred from actual recruit_type fields.
    const recruitmentTypes = [
        { id: "201", name: "正式", note: "campus new-grad (portal-channel: campus, ~357 posts)" },
        { id: "202", name: "实习", note: "intern (portal-channel: internship, ~729 posts)" },
    ];
    const result = {
        ok: true,
        source: "xiaomi.jobs.f.mioffice.cn",
        jobFunctions,
        cities,
        subjects,
        recruitmentTypes,
    };
    _filterCache = result;
    return result;
}
// ---------- stub notices (no public notices endpoint) ----------
const STUB_NOTICES = {
    ok: false,
    source: "xiaomi.jobs.f.mioffice.cn",
    message: "Xiaomi: no public notices endpoint",
};
export async function listNotices() {
    return STUB_NOTICES;
}
export async function getNotice(_id) {
    return {
        ok: false,
        source: "xiaomi.jobs.f.mioffice.cn",
        message: "Xiaomi: no public notices endpoint",
    };
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return {
        ok: false,
        source: "xiaomi.jobs.f.mioffice.cn",
        message: "Xiaomi: no public notices endpoint",
    };
}
// ---------- matchResume ----------
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 20);
    const channel = opts.channel ?? channelForScope(opts.scope) ?? "campus";
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: "xiaomi.jobs.f.mioffice.cn",
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const defaultRecruitId = channel === "internship" ? "202" : "201";
    const queries = pickDistinctiveTerms(terms, 3);
    if (!queries.length)
        queries.push(terms[0] ?? "");
    const [posLists, rawResults] = await Promise.all([
        Promise.all(queries.map((q) => searchPositions({ keyword: q, page: 1, pageSize: 100, channel }))),
        Promise.all(queries.map((q) => {
            const payload = {
                keyword: q, limit: 100, offset: 0, portal_type: 3, portal_entrance: 1, language: "zh",
            };
            if (channel !== "social") {
                payload.recruitment_id_list = [defaultRecruitId];
            }
            return call("/search/job/posts", payload, channel);
        })),
    ]);
    const seen = new Set();
    const pool = [];
    let lastErr;
    for (const l of posLists) {
        if (!l.ok) {
            lastErr = l.message;
            continue;
        }
        for (const p of l.positions) {
            if (!seen.has(p.post_id)) {
                seen.add(p.post_id);
                pool.push(p);
            }
        }
    }
    if (!pool.length) {
        const broad = await searchPositions({ page: 1, pageSize: 100, channel });
        if (broad.ok)
            pool.push(...broad.positions);
    }
    if (!pool.length) {
        return { ok: false, source: "xiaomi.jobs.f.mioffice.cn", message: lastErr ?? "no positions returned", positions: [] };
    }
    const rawPosts = rawResults.flatMap((r) => r.ok ? (r.data?.job_post_list ?? []) : []);
    const rawById = new Map();
    for (const p of rawPosts) {
        rawById.set(String(p.id ?? ""), p);
    }
    const scored = [];
    for (const p of pool) {
        const rp = rawById.get(p.post_id);
        const blob = [
            p.title,
            p.project,
            p.recruit_label,
            p.work_cities,
            rp?.description ?? "",
            rp?.requirement ?? "",
        ].join(" ");
        const { score, reasons } = scoreOverlap(blob, terms, cities);
        if (score > 0) {
            scored.push({
                score,
                position: p,
                reasons,
                description: rp?.description,
                requirements: rp?.requirement,
            });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    let shortlist = scored.slice(0, Math.max(topN, candidates));
    if (!shortlist.length) {
        shortlist = pool.slice(0, candidates).map((position) => ({
            score: 0,
            position,
            reasons: [],
            description: rawById.get(position.post_id)?.description,
            requirements: rawById.get(position.post_id)?.requirement,
        }));
    }
    const matches = shortlist.slice(0, topN).map((s) => {
        const mr = s.reasons.length > 0
            ? s.reasons.slice(0, 5)
            : ["no specific keyword overlap — surfaced from initial keyword search"];
        return {
            ...s.position,
            description: s.description,
            requirements: s.requirements,
            match_reasons: mr,
        };
    });
    return {
        ok: true,
        source: "xiaomi.jobs.f.mioffice.cn",
        channel,
        extracted_terms: terms,
        city_preferences: cities,
        matches,
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
