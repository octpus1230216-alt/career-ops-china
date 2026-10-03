// Thin client for 智谱AI (ZhipuAI / GLM) careers, hosted on Feishu Recruiting (ATSX).
//
// ============================================================
// Discovery notes (probed 2026-05):
//
//   Attempted endpoints:
//     https://zhipuai.cn/careers           — SSL/network error (not reachable from CLI)
//     https://careers.zhipuai.cn/          — SSL/network error
//     https://hr.zhipuai.cn/               — SSL/network error
//     https://zhipu.jobs.feishu.cn/        — HTTP 404 (tenant not configured)
//     https://zhipuai.jobs.feishu.cn/      — HTTP 404 (tenant not configured)
//
//   Live endpoint: https://zhipu-ai.jobs.feishu.cn/
//     Host:    zhipu-ai.jobs.feishu.cn
//     Channel: "index"  (from window.js-websiteInfo → website_info.path)
//     Tenant:  北京智谱华章科技股份有限公司  (tenant_id_md5: 71bfc100479a8c605e8529cddf3ccf2b)
//     Type:    社招官网 (social / experienced hire only — no campus portal found)
//     Total:   ~222 active positions (probed 2026-05)
//
// ============================================================
// Endpoint inventory (verified 2026-05):
//
//   POST https://zhipu-ai.jobs.feishu.cn/api/v1/search/job/posts
//        Payload: { keyword, limit, offset, portal_type:3, portal_entrance:1, language:"zh",
//                   recruitment_id_list?, job_category_id_list?, location_code_list? }
//        Headers: portal-channel: index, portal-platform: pc, website-path: index
//        Response: { code:0, data:{ job_post_list:[...], count:<int> }, message:"ok" }
//
//   GET  https://zhipu-ai.jobs.feishu.cn/api/v1/config/job/filters/index
//        Returns filter taxonomy: job_type_list (5 categories), city_list (6 cities),
//        recruitment_type_list (only "1" = 社招)
//
// ============================================================
// Filter taxonomy (probed 2026-05):
//
//   DIMENSION 1 — job_type_list / job_category_id_list (职位类别)
//     研发                  id: 6791702736615426317
//     产品 / 策划 / 项目    id: 6791702736615409933
//     销售                  id: 6791702736615360781
//     设计                  id: 6791702736615344397
//     市场                  id: 6791702736615377165
//
//   DIMENSION 2 — city_list / location_code_list (城市)
//     北京  CT_11    上海  CT_125   深圳  CT_128
//     杭州  CT_52    成都  CT_22
//     (+ additional cities may appear in posts not listed in filters)
//
//   DIMENSION 3 — recruitment_type_list
//     "1" = 社招 (experienced hire) — the only portal available
//       child "101" = 全职 (full-time), "102" = 实习 (intern if exists)
//
// ============================================================
// ---- PositionSummary field mapping (Zhipu → canonical) ----
//   post_id       ← String(item.id)
//   title         ← item.title
//   project       ← item.job_category.name  (job_function.name as fallback)
//   recruit_label ← item.recruit_type.name  (e.g. "全职")
//   bgs           ← ""  (not exposed in public search)
//   work_cities   ← city_list joined " / " (city_info used as fallback)
//   apply_url     ← https://zhipu-ai.jobs.feishu.cn/index/position/${id}/detail
import { extractResumeSignals, scoreOverlap, checkResume, pickDistinctiveTerms } from "./tencent.js";
export { checkResume };
/** Recruit scopes Zhipu can serve.
 *  Zhipu's Feishu tenant only exposes a social/experienced channel
 *  (recruitment_type_list = [{ id:"1", name:"社招" }]); there is no campus
 *  or intern portal. Both "social" and "all" map to the same query. */
export const supportedScopes = ["social", "all"];
const HOST = "zhipu-ai.jobs.feishu.cn";
const CHANNEL = "index";
const API_ROOT = `https://${HOST}/api/v1`;
const POSITION_PAGE = `https://${HOST}/${CHANNEL}/position`;
const DETAIL_PAGE = (id) => `https://${HOST}/${CHANNEL}/position/${encodeURIComponent(id)}/detail`;
const SOURCE = HOST;
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "portal-channel": CHANNEL,
    "portal-platform": "pc",
    "website-path": CHANNEL,
    Referer: POSITION_PAGE,
};
async function call(path, body) {
    const url = `${API_ROOT}${path}`;
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: DEFAULT_HEADERS,
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
function summarizePosition(item) {
    const id = String(item.id ?? "");
    const cityList = item.city_list ?? [];
    let work_cities;
    if (cityList.length > 1) {
        work_cities = cityList.map((c) => c.name ?? "").filter(Boolean).join(" / ");
    }
    else {
        work_cities = cityList[0]?.name ?? item.city_info?.name ?? "";
    }
    // ZhipuAI: job_category is usually populated; job_function is null in public search
    const project = item.job_category?.name ?? item.job_function?.name ?? "";
    return {
        post_id: id,
        title: item.title ?? "",
        project,
        recruit_label: item.recruit_type?.name ?? "",
        bgs: "",
        work_cities,
        apply_url: id ? DETAIL_PAGE(id) : POSITION_PAGE,
    };
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * pageSize;
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    const asStringList = (v) => {
        if (v === undefined)
            return undefined;
        const arr = Array.isArray(v) ? v : [v];
        return arr.map(String);
    };
    const payload = {
        keyword,
        limit: pageSize,
        offset,
        portal_type: 3,
        portal_entrance: 1,
        language: "zh",
    };
    const recruitmentIdList = asStringList(opts.recruitmentIdList);
    if (recruitmentIdList?.length) {
        payload.recruitment_id_list = recruitmentIdList;
    }
    const jobCategoryIdList = asStringList(opts.jobCategoryIdList);
    if (jobCategoryIdList?.length) {
        payload.job_category_id_list = jobCategoryIdList;
    }
    const cityIdList = asStringList(opts.cityIdList);
    if (cityIdList?.length) {
        payload.location_code_list = cityIdList;
    }
    const response = await call("/search/job/posts", payload);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            message: response.message,
            source: SOURCE,
            query: payload,
            positions: [],
        };
    }
    const rows = response.data.job_post_list ?? [];
    return {
        ok: true,
        source: SOURCE,
        query: payload,
        page,
        page_size: pageSize,
        total: response.data.count ?? rows.length,
        positions: rows.map(summarizePosition),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 100));
    const maxPages = Math.max(1, opts.maxPages ?? 5);
    const bucket = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
        const result = await searchPositions({ ...opts, page, pageSize });
        if (!result.ok) {
            return {
                ok: false,
                message: result.message,
                source: SOURCE,
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
        source: SOURCE,
        total: total ?? bucket.length,
        fetched: bucket.length,
        positions: bucket,
    };
}
// ---------- fetchPositionDetail ----------
// Zhipu/Feishu has no public per-post detail REST endpoint.
// Paginate the search and filter by id.
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id)
        return { ok: false, source: SOURCE, message: "post_id is required" };
    const pageSize = 100;
    const maxPages = 5;
    for (let page = 1; page <= maxPages; page++) {
        const offset = (page - 1) * pageSize;
        const payload = {
            keyword: "",
            limit: pageSize,
            offset,
            portal_type: 3,
            portal_entrance: 1,
            language: "zh",
        };
        const response = await call("/search/job/posts", payload);
        if (!response.ok || !response.data)
            break;
        const posts = response.data.job_post_list ?? [];
        const found = posts.find((p) => String(p.id) === id);
        if (found) {
            const summary = summarizePosition(found);
            return {
                ok: true,
                source: SOURCE,
                post_id: id,
                title: found.title ?? "",
                direction: found.sub_title ?? "",
                description: found.description ?? "",
                requirements: found.requirement ?? "",
                work_cities: found.city_list ?? (found.city_info ? [found.city_info] : []),
                apply_url: summary.apply_url,
            };
        }
        if (posts.length < pageSize)
            break;
    }
    return {
        ok: false,
        source: SOURCE,
        post_id: id,
        message: `post ${id} not found in public search results (searched up to ${maxPages * pageSize} posts)`,
    };
}
let _filterCache = null;
export async function fetchDictionaries() {
    if (_filterCache !== null)
        return _filterCache;
    const url = `${API_ROOT}/config/job/filters/${CHANNEL}`;
    let response;
    try {
        response = await fetch(url, { headers: DEFAULT_HEADERS });
    }
    catch (err) {
        const r = {
            ok: false,
            source: SOURCE,
            message: `network error: ${err instanceof Error ? err.message : String(err)}`,
        };
        _filterCache = r;
        return r;
    }
    if (!response.ok) {
        const r = {
            ok: false,
            source: SOURCE,
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
            source: SOURCE,
            message: `bad JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
        _filterCache = r;
        return r;
    }
    if (payload.code !== 0 || !payload.data) {
        const r = {
            ok: false,
            source: SOURCE,
            message: payload.message ?? "upstream error",
        };
        _filterCache = r;
        return r;
    }
    const d = payload.data;
    const jobCategories = (d.job_type_list ?? []).map((cat) => ({
        id: cat.id ?? "",
        name: cat.name ?? "",
        en_name: cat.en_name ?? "",
        depth: cat.depth ?? 1,
        parent_id: cat.parent?.id ?? null,
    }));
    const cities = (d.city_list ?? []).map((c) => ({
        code: c.code ?? "",
        name: c.name ?? "",
        en_name: c.en_name ?? "",
    }));
    // Flatten recruitment_type_list (parent + children)
    const recruitmentTypes = [];
    const seen = new Set();
    const walkRT = (items) => {
        for (const rt of items ?? []) {
            if (rt.id && !seen.has(rt.id)) {
                seen.add(rt.id);
                recruitmentTypes.push({
                    id: rt.id,
                    name: rt.name ?? "",
                    en_name: rt.en_name ?? "",
                });
            }
            if (rt.children?.length)
                walkRT(rt.children);
        }
    };
    walkRT(d.recruitment_type_list);
    // Fallback: known static values when API omits them
    if (!recruitmentTypes.length) {
        recruitmentTypes.push({ id: "1", name: "社招", en_name: "Experienced" }, { id: "101", name: "全职", en_name: "Full-time" });
    }
    const result = {
        ok: true,
        source: SOURCE,
        jobCategories,
        cities,
        recruitmentTypes,
    };
    _filterCache = result;
    return result;
}
// ---------- stub notices ----------
const STUB_NOTICES = {
    ok: false,
    source: SOURCE,
    message: "ZhipuAI: no public notices endpoint",
};
export async function listNotices() {
    return STUB_NOTICES;
}
export async function getNotice(_id) {
    return {
        ok: false,
        source: SOURCE,
        message: "ZhipuAI: no public notices endpoint",
    };
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return {
        ok: false,
        source: SOURCE,
        message: "ZhipuAI: no public notices endpoint",
    };
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
    const queries = pickDistinctiveTerms(terms, 3);
    if (!queries.length)
        queries.push(terms[0] ?? "");
    const [posLists, rawResults] = await Promise.all([
        Promise.all(queries.map((q) => searchPositions({ keyword: q, page: 1, pageSize: 100 }))),
        Promise.all(queries.map((q) => call("/search/job/posts", {
            keyword: q, limit: 100, offset: 0, portal_type: 3, portal_entrance: 1, language: "zh",
        }))),
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
        const broad = await searchPositions({ page: 1, pageSize: 100 });
        if (broad.ok)
            pool.push(...broad.positions);
    }
    if (!pool.length) {
        return { ok: false, source: SOURCE, message: lastErr ?? "no positions returned", positions: [] };
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
        source: SOURCE,
        extracted_terms: terms,
        city_preferences: cities,
        matches,
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
