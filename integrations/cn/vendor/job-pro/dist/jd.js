// Thin client for JD (京东) campus-recruiting API at campus.jd.com.
//
// ============================================================
// Endpoint inventory (probed 2026-05, JS bundle umi.js 20260511224015):
//
//   GET  https://campus.jd.com/api/wx/position/getProjectList
//        Unauthenticated. Returns recruit types (code: present/internship/talent),
//        plan IDs, direction code lists, and BG names.
//        Response: { success:true, body:{ projectList:[...], bgList:[...], bgbuConfig:[...] } }
//
//   POST https://campus.jd.com/api/wx/position/page?type={{type}}
//        Unauthenticated. type = "present" | "internship" | "talent"
//        Payload: { pageSize:int, pageIndex:int,
//                   parameter:{ positionName:str, planIdList:int[], positionDeptList:[],
//                                jobDirectionCodeList:str[], workCityCodeList:str[] } }
//        Response: { success:true, body:{ totalNumber:int, items:[...] } }
//        - pageIndex is 0-BASED: offset = pageSize × pageIndex (re-probed 2026-07-11:
//          present totalNumber=16; pageSize=5/pageIndex=0 → items 1-5 (8006, 7993, ...),
//          pageIndex=1 → items 6-10 (8003, 7999, ...)). The CLI's 1-based --page must
//          be translated to pageIndex = page - 1 before hitting upstream.
//        - Each item has publishId (= post_id), positionName, jobDirection, jobDirectionCode,
//          workContent, qualification, and requirementVoList (array per city/BG).
//        - positionDeptList: the server accepts [] (no-op); no public dictionary for dept codes.
//        - workCityCodeList: city codes from requirementVoList[].workCityCode (e.g. "00001"=北京).
//        - jobDirectionCodeList: string codes from items[].jobDirectionCode.
//        Observed direction codes (probed 2026-05):
//          "01" 采销与物流方向  "02" 技术方向  "03" 产品方向  "04" 运营方向
//          "05" 供应链方向      "06" 设计方向  "09" 保险及金融方向
//          "10" 新锐之星方向    "13" 管理培训生方向  "14" TGT顶尖技术方向
//          "16" 数据方向        "17" 市场方向  "18" 人力方向
//          "19" 财务方向        "20" 法务方向  "30" 基层管理方向
//          "31" 一线销售方向    "34" 职能方向
//
//   GET  https://campus.jd.com/api/wx/position/detail/{{publishId}}
//        Unauthenticated. Returns the same fields as the list item but with full
//        workContent + qualification text. requirementVoList carries positionBg and workCity.
//        Response: { success:true, body:{ publishId, positionName, jobDirection, ... } }
//
// ============================================================
// Endpoints that require JD SSO auth (all redirect to /passport):
//   POST /api/position/list, /api/social/position/list, /api/campus/position/list,
//   /api/wx/position/page?type=... (GET variant), /api/wx/position/delivery/*,
//   /api/wx/resume/*, /api/wx/favorites/*, /api/common/recruit/dict/*
//
// ============================================================
// Recruit types (from getProjectList, probed 2026-05):
//   code "present"    应届生   ~23 positions
//     planId 52 = JDS-新星计划 (directions 01-06)
//     planId 53 = TET-管理培训生 (direction 13)
//     planId 54 = 新锐之星 (direction 10)
//   code "internship" 实习生   ~110 positions
//     planId 45 = JD YOUNG-实习生计划 (directions 03,04,06,16-20)
//     planId 51 = 新锐之星实习生 (direction 10)
//   code "talent"     TGT专项  ~155 positions
//     planId 47 = TGT-顶尖青年技术天才计划 (direction 14)
//     planId 55 = TGT-顶尖青年技术实习生   (direction 14)
//
// ============================================================
// BG names (from getProjectList bgList):
//   京东集团, 京东零售, 京东物流, 京东科技,
//   京东健康, 京东国际, 京东产发, 京东工业, 京东创新零售, CHO体系, CCO体系, CFO体系
//
// ============================================================
// ---- PositionSummary field mapping (JD → canonical) ----
//   post_id       ← String(item.publishId)
//   title         ← item.positionName
//   project       ← item.jobDirection  (职位方向, e.g. "技术方向")
//   recruit_label ← recruitType label  (e.g. "应届生" / "实习生" / "TGT专项")
//   bgs           ← unique positionBg values from requirementVoList joined with " / "
//   work_cities   ← unique workCity values from requirementVoList joined with " / "
//   apply_url     ← https://campus.jd.com/#/newDetails?publishId=<id>
import { extractResumeSignals, scoreOverlap, checkResume, pickDistinctiveTerms } from "./tencent.js";
export { checkResume };
// campus.jd.com is a campus-only portal — there is no social-hire endpoint
// on this domain. JD's 社招 listings live on a separate site that we don't
// scrape. Declaring this lets the dispatcher fail fast on `--scope social`.
export const supportedScopes = ["campus", "intern", "all"];
const API_ROOT = "https://campus.jd.com";
const CAMPUS_PAGE = "https://campus.jd.com/";
const DETAIL_PAGE = (publishId) => `${CAMPUS_PAGE}#/newDetails?publishId=${encodeURIComponent(publishId)}`;
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Referer: CAMPUS_PAGE,
};
// ---------- helpers ----------
async function getJson(url) {
    let response;
    try {
        response = await fetch(url, { headers: DEFAULT_HEADERS });
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
    return { ok: true, data: payload, message: "ok" };
}
async function postJson(url, body) {
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
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, data: payload, message: "ok" };
}
function summarizePosition(item, recruitLabel) {
    const id = String(item.publishId ?? "");
    const reqs = item.requirementVoList ?? [];
    const seenCities = new Set();
    const seenBgs = new Set();
    for (const r of reqs) {
        if (r.workCity)
            seenCities.add(r.workCity);
        if (r.positionBg)
            seenBgs.add(r.positionBg);
    }
    return {
        post_id: id,
        title: item.positionName ?? "",
        project: item.jobDirection ?? "",
        recruit_label: recruitLabel,
        bgs: [...seenBgs].join(" / "),
        work_cities: [...seenCities].join(" / "),
        apply_url: id ? DETAIL_PAGE(id) : CAMPUS_PAGE,
    };
}
// Label mapping for the three recruit type codes
const TYPE_LABELS = {
    present: "应届生",
    internship: "实习生",
    talent: "TGT专项",
};
// ---------- searchPositions ----------
// Scope → recruitType buckets. JD has three buckets; fanning out + dedupe by
// publishId gives users honest data across all of them.
// (Historical note: pre-1.1.15 the CLI sent its 1-based page straight to the
// 0-based upstream pageIndex, so every bucket's first page was skipped. That
// off-by-one is what made "present" look like it "returns totalNumber>0 with
// empty items[]" — the bucket is fine; the CLI was asking for page 2.)
function bucketsForScope(scope) {
    if (scope === "intern")
        return ["internship"];
    if (scope === "campus")
        return ["present", "talent"];
    return ["present", "internship", "talent"];
}
async function searchOneBucket(recruitType, opts, page, pageSize) {
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    const payload = {
        pageSize,
        // Upstream pageIndex is 0-based (offset = pageSize × pageIndex; probed
        // 2026-07-11, see endpoint inventory at the top of this file). The CLI's
        // page is 1-based, so subtract 1 here.
        pageIndex: page - 1,
        parameter: {
            positionName: keyword,
            planIdList: opts.planIdList ?? [],
            positionDeptList: [],
            jobDirectionCodeList: opts.jobDirectionCodeList ?? [],
            workCityCodeList: opts.workCityCodeList ?? [],
        },
    };
    const url = `${API_ROOT}/api/wx/position/page?type=${encodeURIComponent(recruitType)}`;
    const resp = await postJson(url, payload);
    return { recruitType, resp, payload };
}
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    // Explicit recruitType wins; otherwise derive from scope (or fan out).
    const buckets = opts.recruitType ? [opts.recruitType] : bucketsForScope(opts.scope);
    const results = await Promise.all(buckets.map((b) => searchOneBucket(b, opts, page, pageSize)));
    // If every bucket errored at transport / envelope level, surface the first error.
    const allFailed = results.every(({ resp }) => !resp.ok || !resp.data || !resp.data.success);
    if (allFailed) {
        const first = results[0];
        return {
            ok: false,
            source: "campus.jd.com",
            message: first.resp.data?.errorMessage ?? first.resp.message ?? "upstream returned success=false",
            query: first.payload,
            page,
            page_size: pageSize,
            total: 0,
            positions: [],
        };
    }
    // Merge by publishId across buckets; label by the bucket each row came from.
    const seen = new Set();
    const positions = [];
    let total = 0;
    for (const { recruitType, resp } of results) {
        if (!resp.ok || !resp.data || !resp.data.success)
            continue;
        const recruitLabel = TYPE_LABELS[recruitType] ?? recruitType;
        const items = resp.data.body?.items ?? [];
        total += resp.data.body?.totalNumber ?? items.length;
        for (const item of items) {
            const id = String(item.publishId ?? "");
            if (id && seen.has(id))
                continue;
            if (id)
                seen.add(id);
            positions.push(summarizePosition(item, recruitLabel));
        }
    }
    return {
        ok: true,
        source: "campus.jd.com",
        query: results[0].payload,
        page,
        page_size: pageSize,
        buckets,
        total,
        positions,
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(200, opts.pageSize ?? 100));
    const maxPages = Math.max(1, opts.maxPages ?? 10);
    const bucket = [];
    const seen = new Set();
    let total;
    // true once we hit a natural stop (empty page / no new ids / reached total);
    // if we instead run out of maxPages, the result is reported as truncated.
    let exhausted = false;
    for (let page = 1; page <= maxPages; page++) {
        const result = await searchPositions({ ...opts, page, pageSize });
        if (!result.ok) {
            return {
                ok: false,
                source: "campus.jd.com",
                message: result.message,
                total: total ?? 0,
                fetched: bucket.length,
                positions: bucket,
            };
        }
        if (total === undefined)
            total = result.total;
        // Dedupe by post_id across pages/buckets (searchPositions already dedupes
        // within a single page's bucket fan-out, but not across pages).
        let added = 0;
        for (const p of result.positions) {
            if (p.post_id) {
                if (seen.has(p.post_id))
                    continue;
                seen.add(p.post_id);
            }
            bucket.push(p);
            added++;
        }
        if (!result.positions.length || added === 0) {
            exhausted = true;
            break;
        }
        if (total !== undefined && bucket.length >= total) {
            exhausted = true;
            break;
        }
    }
    return {
        ok: true,
        source: "campus.jd.com",
        total: total ?? bucket.length,
        fetched: bucket.length,
        ...(exhausted ? {} : { truncated: true }),
        positions: bucket,
    };
}
// ---------- fetchPositionDetail ----------
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id) {
        return {
            ok: false,
            source: "campus.jd.com",
            message: "post_id is required",
        };
    }
    const url = `${API_ROOT}/api/wx/position/detail/${encodeURIComponent(id)}`;
    const resp = await getJson(url);
    if (!resp.ok || !resp.data) {
        return {
            ok: false,
            source: "campus.jd.com",
            post_id: id,
            message: resp.message,
        };
    }
    if (!resp.data.success) {
        return {
            ok: false,
            source: "campus.jd.com",
            post_id: id,
            message: resp.data.errorMessage ?? "upstream returned success=false",
        };
    }
    const raw = resp.data.body;
    if (!raw) {
        return {
            ok: false,
            source: "campus.jd.com",
            post_id: id,
            message: "empty body in detail response",
        };
    }
    const reqs = raw.requirementVoList ?? [];
    const seenCities = [];
    const seenBgs = [];
    const seenCitySet = new Set();
    const seenBgSet = new Set();
    for (const r of reqs) {
        if (r.workCity && !seenCitySet.has(r.workCity)) {
            seenCities.push(r.workCity);
            seenCitySet.add(r.workCity);
        }
        if (r.positionBg && !seenBgSet.has(r.positionBg)) {
            seenBgs.push(r.positionBg);
            seenBgSet.add(r.positionBg);
        }
    }
    return {
        ok: true,
        source: "campus.jd.com",
        post_id: String(raw.publishId ?? id),
        title: raw.positionName ?? "",
        direction: raw.jobDirection ?? "",
        description: raw.workContent ?? "",
        requirements: raw.qualification ?? "",
        work_cities: seenCities,
        recruit_cities: reqs
            .map((r) => r.interviewCity)
            .filter((v) => Boolean(v))
            .filter((v, i, arr) => arr.indexOf(v) === i),
        bgs: seenBgs,
        apply_url: DETAIL_PAGE(String(raw.publishId ?? id)),
    };
}
// ---------- fetchDictionaries ----------
// GET /api/wx/position/getProjectList is unauthenticated and returns the full
// recruit-type × plan × direction taxonomy plus the BG name list.
// No city dictionary or department code dictionary exists publicly.
let _projectCache = null;
function _buildDictResult(data) {
    const body = data.body ?? {};
    const projectList = body.projectList ?? [];
    const plans = [];
    for (const p of projectList) {
        for (const g of p.groupList ?? []) {
            for (const pm of g.planMapList ?? []) {
                plans.push({
                    id: pm.id ?? 0,
                    name: pm.planName ?? "",
                    recruitType: p.type ?? "",
                    recruitTypeCode: p.code ?? "",
                    directionCodes: pm.directionList ?? [],
                });
            }
        }
    }
    const knownDirections = {
        "01": "采销与物流方向",
        "02": "技术方向",
        "03": "产品方向",
        "04": "运营方向",
        "05": "供应链方向",
        "06": "设计方向",
        "09": "保险及金融方向",
        "10": "新锐之星方向",
        "13": "管理培训生方向",
        "14": "TGT顶尖技术方向",
        "16": "数据方向",
        "17": "市场方向",
        "18": "人力方向",
        "19": "财务方向",
        "20": "法务方向",
        "30": "基层管理方向",
        "31": "一线销售方向",
        "34": "职能方向",
    };
    return {
        ok: true,
        source: "campus.jd.com",
        verified_at: new Date().toISOString(),
        recruit_types: projectList.map((p) => ({
            code: p.code ?? "",
            name: p.type ?? "",
            label: TYPE_LABELS[p.code ?? ""] ?? p.type ?? "",
        })),
        plans,
        job_directions: Object.entries(knownDirections).map(([code, name]) => ({ code, name })),
        business_groups: body.bgList ?? [],
        business_group_details: (body.bgbuConfig ?? []).map((b) => ({
            name: b.name ?? "",
            queryName: b.queryName ?? "",
            description: b.descriptions ?? "",
        })),
        note: "City codes live in requirementVoList[].workCityCode on each position item — " +
            "no public city dictionary endpoint exists. " +
            "Department codes are not publicly exposed.",
    };
}
export async function fetchDictionaries() {
    if (_projectCache !== null)
        return _projectCache;
    const url = `${API_ROOT}/api/wx/position/getProjectList`;
    const resp = await getJson(url);
    if (!resp.ok || !resp.data) {
        const r = {
            ok: false,
            source: "campus.jd.com",
            message: `JD: getProjectList failed — ${resp.message}`,
        };
        return r;
    }
    if (!resp.data.success) {
        const r = {
            ok: false,
            source: "campus.jd.com",
            message: `JD: getProjectList returned success=false — ${resp.data.errorMessage ?? ""}`,
        };
        return r;
    }
    const result = _buildDictResult(resp.data);
    _projectCache = result;
    return result;
}
// ---------- stub notices ----------
// No public notice/announcement endpoint was found.
const STUB_NOTICES_RESULT = {
    ok: false,
    source: "campus.jd.com",
    message: "JD: no public notices endpoint",
};
export async function listNotices() {
    return STUB_NOTICES_RESULT;
}
export async function getNotice(_id) {
    return {
        ok: false,
        source: "campus.jd.com",
        message: "JD: no public notices endpoint",
    };
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return {
        ok: false,
        source: "campus.jd.com",
        message: "JD: no public notices endpoint",
    };
}
// ---------- matchResume ----------
// Mirror tencent's algorithm:
// 1. Extract signals from resume text.
// 2. Search with top-3 terms as keyword across recruitType="internship" (larger pool).
// 3. Score each position against title + direction + BG + cities + description blobs.
// 4. Enrich top candidates with full detail and re-score.
// 5. Return top N matches with reasons.
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 20);
    const recruitType = opts.recruitType ?? "internship";
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: "campus.jd.com",
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const queries = pickDistinctiveTerms(terms, 3);
    if (!queries.length)
        queries.push(terms[0] ?? "");
    const lists = await Promise.all(queries.map((q) => searchPositions({ keyword: q, page: 1, pageSize: 20, recruitType })));
    const seenIds = new Set();
    const pool = [];
    let lastErr;
    for (const l of lists) {
        if (!l.ok) {
            lastErr = l.message;
            continue;
        }
        for (const p of l.positions) {
            if (!seenIds.has(p.post_id)) {
                seenIds.add(p.post_id);
                pool.push(p);
            }
        }
    }
    if (!pool.length) {
        const broad = await searchPositions({ page: 1, pageSize: 20, recruitType });
        if (broad.ok)
            pool.push(...broad.positions);
    }
    if (!pool.length) {
        return {
            ok: false,
            source: "campus.jd.com",
            message: lastErr ?? "no positions returned",
            positions: [],
        };
    }
    const scored = [];
    for (const p of pool) {
        const blob = [p.title, p.project, p.recruit_label, p.bgs, p.work_cities].join(" ");
        const { score, reasons } = scoreOverlap(blob, terms, cities);
        if (score > 0) {
            scored.push({ score, position: p, reasons });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    let shortlist = scored.slice(0, Math.max(topN, candidates));
    if (!shortlist.length) {
        // Fallback: return first candidates from pool
        shortlist = pool.slice(0, candidates).map((position) => ({
            score: 0,
            position,
            reasons: [],
        }));
    }
    const enriched = [];
    for (const { score: baseScore, position, reasons: baseReasons } of shortlist.slice(0, candidates)) {
        const detail = await fetchPositionDetail(position.post_id);
        let extraScore = 0;
        let extraReasons = [];
        let description;
        let requirements;
        if (detail.ok) {
            description = detail.description;
            requirements = detail.requirements;
            const detailBlob = [
                detail.title,
                detail.direction,
                detail.description,
                detail.requirements,
                detail.bgs.join(" "),
                detail.work_cities.join(" "),
            ].join(" ");
            const r = scoreOverlap(detailBlob, terms, cities);
            extraScore = r.score;
            extraReasons = r.reasons;
        }
        const combined = [...new Set([...baseReasons, ...extraReasons])].slice(0, 5);
        if (!combined.length) {
            combined.push("no specific keyword overlap — surfaced from initial keyword search");
        }
        enriched.push({
            score: baseScore + extraScore,
            row: {
                ...position,
                description,
                requirements,
                match_reasons: combined,
            },
        });
    }
    enriched.sort((a, b) => b.score - a.score);
    return {
        ok: true,
        source: "campus.jd.com",
        extracted_terms: terms,
        city_preferences: cities,
        matches: enriched.slice(0, topN).map((e) => e.row),
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
