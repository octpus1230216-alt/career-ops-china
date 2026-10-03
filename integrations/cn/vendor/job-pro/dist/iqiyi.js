// Thin client for iQIYI's public recruiting API at careers.iqiyi.com.
//
// iQIYI runs three separate portals on careers.iqiyi.com, all powered by
// Feishu/Lark ATSX SaaS recruiting product (same engine as jobs.bytedance.com).
// The portal is determined by the "website-path" request header.
//
// ============================================================
// Endpoint inventory (probed 2026-05, JS bundle 4026.f23f1edc.js):
//
//   POST https://careers.iqiyi.com/api/v1/search/job/posts
//        Headers: website-path, portal-platform: "pc", Referer (matching portal)
//        Payload: { keyword, limit, offset, portal_type:3, portal_entrance:1, language:"zh",
//                   location_code_list, job_function_id_list, recruitment_id_list }
//        Response: { code:0, data:{ job_post_list:[...], count:<int> } }
//
//   GET  https://careers.iqiyi.com/api/v1/config/job/filters/{website_path}
//        Returns city_list, recruitment_type_list, job_function_list, etc.
//        Note: job_type_list and job_subject_list are null/empty for this tenant.
//
//   GET  https://careers.iqiyi.com/api/v1/job/posts/{post_id}
//        Returns { code:0, data:{ job_post_detail:{...}, recommend_job_post_List:[...] } }
//
// ============================================================
// Portal / website-path contexts (probed 2026-05):
//
//   "job"    → 社招官网  (social/experienced hire) ~82 posts
//              Referer: https://careers.iqiyi.com/job
//              recruit_type.parent.id="1" (社招), recruit_type.id="101" (全职)
//              Detail URL: https://careers.iqiyi.com/job/position/{id}/detail
//
//   "campus" → 应届生校招官网 (campus / new-grad)  ~14 posts
//              Referer: https://careers.iqiyi.com/campus/
//              recruit_type.id="201" (正式), parent.id="2" (校招)
//              Detail URL: https://careers.iqiyi.com/campus/position/{id}/detail
//
//   "intern" → 实习生官网 (intern)  ~92 posts
//              Referer: https://careers.iqiyi.com/intern
//              recruit_type.id="202" (实习), parent.id="2" (校招)
//              Detail URL: https://careers.iqiyi.com/intern/position/{id}/detail
//
// ============================================================
// Filter taxonomy (from GET /api/v1/config/job/filters/job, probed 2026-05):
//
// DIMENSION 1 — job_function_id_list (职位类别, 2-level hierarchy)
//   Parent "技术"          id:7434839649275742501
//     研发                 id:7434839421294070035
//     算法                 id:7434839934659873034
//   Parent "产品"          id:7434840292215736586
//   Parent "设计"          id:7434840107360061732
//   Parent "运营"          id:7434840970217654564
//     产品运营             id:7434840444482308364
//     内容运营             id:7434841054879451446
//     数据分析             id:7434840662343174454
//   Parent "内容制作"      id:7434840477089040652
//     导演                 id:7434841298710907145
//     责编                 id:7434841298711005449
//     评估策划             id:7434841764354066739
//     视频制作             id:7434841763418573068
//   Parent "经纪"          id:7434841763417753895
//   Parent "市场&商务"     id:7434841893740267786
//     商务                 id:7434841893487692059
//     公关                 id:7434842142922819881
//     市场活动             id:7434842142922869033
//     商业市场             id:7434841764362307867
//     广告投放             id:7512307407088208164
//     内容宣推             id:7434842241422215475
//   Parent "销售"          id:7434843070048717094
//     销售                 id:7434842895259879743
//     销售策划             id:7434842715382843660
//   Parent "游戏"          id:7434844424062535947
//     游戏美术             id:7434845034699147539
//   Parent "客服、审核与运营支持" id:7512307407469840681
//     运营支持             id:7512307631945828619
//     客服                 id:7512307201551616306
//   Parent "财务"          id:7434843924135184679
//   Parent "人力资源"      id:7434844421612734757
//   Parent "管理"          id:7434845114970130738
//
// DIMENSION 2 — location_code_list (工作地点, city codes)
//   CT_11=北京 CT_125=上海 CT_190=重庆 CT_78=开封 CT_71=金华
//   CT_172=扬州 CT_98=曼谷 CT_94=洛杉矶
//
// DIMENSION 3 — recruitment_id_list (招聘类型, for campus/intern)
//   "201" = 正式 (campus / new-grad)
//   "202" = 实习 (intern)
//   "101" = 全职 (full-time, used in social hire context)
//
// ============================================================
// ---- PositionSummary field mapping (iQIYI → canonical) ----
//   post_id       ← item.id  (stringified)
//   title         ← item.title
//   project       ← item.job_function.name  (最接近 Tencent projectName)
//   recruit_label ← item.recruit_type.name  (e.g. "全职" / "正式" / "实习")
//   bgs           ← ""  (iQIYI does not expose BG/事业群 in public search)
//   work_cities   ← city_list joined with " / " or city_info.name
//   apply_url     ← https://careers.iqiyi.com/{website_path}/position/{id}/detail
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
/** Recruit scopes iQIYI can serve.
 *  iQIYI runs three Feishu portals on careers.iqiyi.com selected by the
 *  website-path header: "job" (社招), "campus" (校招), "intern" (实习).
 *  All four canonical scopes map cleanly:
 *    social → portal "job"  (default)
 *    campus → portal "campus"
 *    intern → portal "intern"
 *    all    → portal "job"  (no merge: caller can iterate scope explicitly) */
export const supportedScopes = ["social", "campus", "intern", "all"];
/** CLI scope → upstream portal mapping. */
function portalForScope(scope) {
    if (scope === "campus")
        return "campus";
    if (scope === "intern")
        return "intern";
    // scope=social, scope=all, scope=undefined → default social portal "job"
    return "job";
}
const API_ROOT = "https://careers.iqiyi.com/api/v1";
// Portal paths and their Referer URLs
const PORTAL = {
    job: {
        referer: "https://careers.iqiyi.com/job",
        listPage: "https://careers.iqiyi.com/job",
        detailPage: (id) => `https://careers.iqiyi.com/job/position/${encodeURIComponent(id)}/detail`,
    },
    campus: {
        referer: "https://careers.iqiyi.com/campus/",
        listPage: "https://careers.iqiyi.com/campus/",
        detailPage: (id) => `https://careers.iqiyi.com/campus/position/${encodeURIComponent(id)}/detail`,
    },
    intern: {
        referer: "https://careers.iqiyi.com/intern",
        listPage: "https://careers.iqiyi.com/intern",
        detailPage: (id) => `https://careers.iqiyi.com/intern/position/${encodeURIComponent(id)}/detail`,
    },
};
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "portal-platform": "pc",
};
async function callPost(path, body, portalPath) {
    const url = `${API_ROOT}${path}`;
    const portal = PORTAL[portalPath];
    let response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                ...DEFAULT_HEADERS,
                "Content-Type": "application/json",
                "website-path": portalPath,
                Referer: portal.referer,
            },
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
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
        ok: payload.code === 0,
        data: payload.data,
        message: payload.message || (payload.code === 0 ? "ok" : "upstream error"),
    };
}
async function callGet(path, portalPath) {
    const url = `${API_ROOT}${path}`;
    const portal = PORTAL[portalPath];
    let response;
    try {
        response = await fetch(url, {
            headers: {
                ...DEFAULT_HEADERS,
                "website-path": portalPath,
                Referer: portal.referer,
            },
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
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    return {
        ok: payload.code === 0,
        data: payload.data,
        message: payload.message || (payload.code === 0 ? "ok" : "upstream error"),
    };
}
function summarizePosition(item, portalPath) {
    const id = String(item.id ?? "");
    const portal = PORTAL[portalPath];
    // Build work_cities: prefer city_list for multi-city, fall back to city_info
    const cityList = item.city_list ?? [];
    let work_cities;
    if (cityList.length > 1) {
        work_cities = cityList.map((c) => c.name ?? "").filter(Boolean).join(" / ");
    }
    else {
        work_cities = item.city_info?.name ?? (cityList[0]?.name ?? "");
    }
    return {
        post_id: id,
        title: item.title ?? "",
        project: item.job_function?.name ?? "",
        recruit_label: item.recruit_type?.name ?? "",
        bgs: "",
        work_cities,
        apply_url: id ? portal.detailPage(id) : portal.listPage,
    };
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * pageSize;
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    // Explicit portal wins; otherwise derive from canonical scope.
    const portalPath = opts.portal ?? portalForScope(opts.scope);
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
    const jobFunctionIdList = asStringList(opts.jobFunctionIdList);
    if (jobFunctionIdList?.length) {
        payload.job_function_id_list = jobFunctionIdList;
    }
    const cityCodeList = asStringList(opts.cityCodeList);
    if (cityCodeList?.length) {
        payload.location_code_list = cityCodeList;
    }
    const recruitmentIdList = asStringList(opts.recruitmentIdList);
    if (recruitmentIdList?.length) {
        payload.recruitment_id_list = recruitmentIdList;
    }
    const response = await callPost("/search/job/posts", payload, portalPath);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            message: response.message,
            source: "careers.iqiyi.com",
            portal: portalPath,
            query: payload,
            positions: [],
        };
    }
    const rows = response.data.job_post_list ?? [];
    return {
        ok: true,
        source: "careers.iqiyi.com",
        portal: portalPath,
        query: payload,
        page,
        page_size: pageSize,
        total: response.data.count ?? rows.length,
        positions: rows.map((r) => summarizePosition(r, portalPath)),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 100));
    const maxPages = Math.max(1, opts.maxPages ?? 5);
    const portalPath = opts.portal ?? portalForScope(opts.scope);
    const bucket = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
        const result = await searchPositions({ ...opts, page, pageSize, portal: portalPath });
        if (!result.ok) {
            return {
                ok: false,
                message: result.message,
                source: "careers.iqiyi.com",
                portal: portalPath,
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
        source: "careers.iqiyi.com",
        portal: portalPath,
        total: total ?? bucket.length,
        fetched: bucket.length,
        positions: bucket,
    };
}
// ---------- fetchPositionDetail ----------
export async function fetchPositionDetail(postId, portal = "job") {
    const id = (postId ?? "").trim();
    if (!id) {
        return { ok: false, source: "careers.iqiyi.com", message: "post_id is required" };
    }
    const response = await callGet(`/job/posts/${encodeURIComponent(id)}`, portal);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            source: "careers.iqiyi.com",
            post_id: id,
            message: response.message || "no detail returned",
        };
    }
    const raw = response.data.job_post_detail;
    if (!raw) {
        return {
            ok: false,
            source: "careers.iqiyi.com",
            post_id: id,
            message: "job_post_detail missing in response",
        };
    }
    const cityList = raw.city_list ?? raw.city_info_list_for_delivery ?? [];
    const work_cities = cityList.length
        ? cityList.map((c) => c.name ?? "").filter(Boolean).join(" / ")
        : (raw.city_info?.name ?? "");
    const summary = summarizePosition(raw, portal);
    return {
        ok: true,
        source: "careers.iqiyi.com",
        portal,
        post_id: String(raw.id ?? id),
        title: raw.title ?? "",
        direction: raw.sub_title ?? "",
        project: raw.job_function?.name ?? "",
        recruit_label: raw.recruit_type?.name ?? "",
        description: raw.description ?? "",
        requirements: raw.requirement ?? "",
        work_cities,
        apply_url: summary.apply_url,
    };
}
// ---------- fetchDictionaries ----------
export async function fetchDictionaries(portal = "job") {
    const response = await callGet(`/config/job/filters/${portal}`, portal);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            source: "careers.iqiyi.com",
            portal,
            message: response.message,
        };
    }
    const d = response.data;
    const jobFunctions = (d.job_function_list ?? []).map((f) => ({
        id: f.id ?? "",
        name: f.name ?? "",
        parent_id: f.parent?.id ?? null,
        children: (f.children ?? []).map((c) => ({
            id: c.id ?? "",
            name: c.name ?? "",
        })),
    }));
    const cities = (d.city_list ?? []).map((c) => ({
        code: c.code ?? "",
        name: c.name ?? "",
        en_name: c.en_name ?? "",
    }));
    const recruitmentTypes = (d.recruitment_type_list ?? []).map((r) => ({
        id: r.id ?? "",
        name: r.name ?? "",
        en_name: r.en_name ?? "",
        parent_id: r.parent?.id ?? null,
    }));
    return {
        ok: true,
        source: "careers.iqiyi.com",
        portal,
        verified_at: new Date().toISOString(),
        jobFunctions,
        cities,
        recruitmentTypes,
        portals: [
            { path: "job", name: "社招官网", note: "experienced hire (~82 posts)" },
            { path: "campus", name: "应届生校招官网", note: "campus / new-grad (~14 posts)" },
            { path: "intern", name: "实习生官网", note: "intern (~92 posts)" },
        ],
    };
}
// ---------- stub notices ----------
// careers.iqiyi.com has no public structured notices/announcements endpoint.
const STUB_SOURCE = "careers.iqiyi.com";
const STUB_MSG = "iQIYI: no public notices endpoint on careers.iqiyi.com";
export async function listNotices() {
    return { ok: false, source: STUB_SOURCE, message: STUB_MSG };
}
export async function getNotice(_id) {
    return { ok: false, source: STUB_SOURCE, message: STUB_MSG };
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return { ok: false, source: STUB_SOURCE, message: STUB_MSG };
}
// ---------- matchResume ----------
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 20);
    const portal = opts.portal ?? "job";
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: STUB_SOURCE,
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const keyword = terms.slice(0, 3).join(" ");
    const list = await searchPositions({ keyword, pageSize: 100, portal });
    if (!list.ok) {
        return { ok: false, source: STUB_SOURCE, message: list.message, positions: [] };
    }
    // Broaden pool if keyword search returns few results
    let allPositions = list.positions;
    if (allPositions.length < candidates) {
        const broad = await searchPositions({ pageSize: 100, portal });
        if (broad.ok) {
            const seen = new Set(allPositions.map((p) => p.post_id));
            for (const p of broad.positions) {
                if (!seen.has(p.post_id)) {
                    allPositions = [...allPositions, p];
                    seen.add(p.post_id);
                }
            }
        }
    }
    const scored = [];
    for (const p of allPositions) {
        const blob = [p.title, p.project, p.recruit_label, p.work_cities].join(" ");
        const { score, reasons } = scoreOverlap(blob, terms, cities);
        if (score > 0) {
            scored.push({ score, position: p, reasons });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    let shortlist = scored.slice(0, Math.max(topN, candidates));
    if (!shortlist.length) {
        shortlist = allPositions.slice(0, candidates).map((position) => ({
            score: 0,
            position,
            reasons: [],
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
        source: STUB_SOURCE,
        portal,
        extracted_terms: terms,
        city_preferences: cities,
        matches,
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
