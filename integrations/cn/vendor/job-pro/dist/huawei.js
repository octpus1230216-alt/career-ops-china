// Thin client for Huawei's public campus-recruiting portal at career.huawei.com.
//
// ============================================================
// Endpoint discovery (probed 2026-05, JS bundles HwPortalReccamp.js,
// portal5/campus-recruitment.html):
//
// Final URL after redirect chain:
//   career.huawei.com → reccampportal/ → campus4_index.html
//   → /reccampportal/portal5/index.html  (SPA)
//   → /reccampportal/portal5/campus-recruitment.html (job search page)
//
// Session:
//   The portal sets JSESSIONID on the first GET to /reccampportal/ (no login
//   required). All public endpoints accept the session or even work without it.
//
// ============================================================
// Endpoint inventory (unauthenticated, no CSRF token needed):
//
//   GET  https://career.huawei.com/reccampportal/services/portal/portalpub/
//            getJob/newHr/page/{pageSize}/{curPage}
//        Query params: jobType, jobTypes, searchText, jobFamClsCode, language,
//                      reqTime, orderBy, cityCode, countryCode, graduateItem
//        Response: { pageVO:{totalRows,curPage,pageSize,totalPages,...}, result:[...] }
//
//        jobType/jobTypes semantics (mapped from campus-recruitment.html Vue data):
//          jobType=0, jobTypes=2  → 应届生 (new-grad / campus) — default zh_CN, ~60 posts
//          jobType=0, jobTypes=1  → 留学生 (overseas students)
//          jobType=0, jobTypes=0  → 实习生 (intern) — actually returns PhD 博士, ~30 posts
//          jobType=2, jobTypes=null → 博士生 (PhD)
//          jobType=0, jobTypes=-1 → 博士生 (PhD, same as jobType=2)
//          jobType=0, jobTypes=-2 → 海外博士 (overseas PhD)
//          jobType=0, jobTypes=-3 → 中方博士 (Chinese PhD)
//          jobType=0, jobTypes=7  → 海外本地 (overseas local)
//          jobType=3              → all types combined (~420 posts in 2026-05)
//          Default (no filter):  jobType=0 → ~328 posts (all campus types)
//
//   GET  https://career.huawei.com/reccampportal/services/portal/portalpub/
//            getJobDetail/newHr?jobId={jobId}&dataSource={dataSource}&language=zh_CN
//        The {jobId} is item.jobId from the search result (NOT advertisementsIntegrationId).
//        Response: flat object with jobname, mainBusiness, jobRequire, jobAddress, jobFamilyName, etc.
//        NOTE: many posts return generic placeholder text for mainBusiness/jobRequire;
//        use findIntentListByJobRequirementId for the real JD.
//
//   GET  https://career.huawei.com/reccampportal/services/portal/portaluser/
//            findIntentListByJobRequirementId/newHr/{language}/{jobRequirementId}/null
//        Query params: dataSource, jobId
//        Returns array of position intents; each intent has full jobResponsibilities,
//        jobDemand, deptName, jobPlaceName, positionIntention (sub-position title).
//        This is the real JD when the top-level description is a placeholder.
//
// ============================================================
// Endpoints that are NOT public (require user login):
//   services/portal/portaluser/applyJob/newHr
//   services/portal/portaluser/collectJob/newHr
//   services/portal/portalpub/getJobAllCount       (→ 404)
//   services/portal/portalpub/findStatAddress/     (→ 404)
//   services/portal/portalpub/list/lang/           (→ 403)
//
// ============================================================
// PositionSummary field mapping (Huawei → canonical):
//   post_id       ← String(item.jobId)                 (internal job ID, used for detail API)
//   title         ← item.jobname
//   project       ← item.jobFamilyName                  (职族, e.g. "研发族" / "销售族")
//   recruit_label ← derived from jobTypes param         (e.g. "应届生" / "博士生")
//   bgs           ← ""                                  (not exposed in public search)
//   work_cities   ← item.jobArea                        (pre-formatted Chinese city list)
//   apply_url     ← https://career.huawei.com/reccampportal/portal5/campus-recruitment-detail.html
//                     ?jobId={item.jobId}&dataSource={item.dataSource}
//
// ============================================================
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
/**
 * Huawei supports campus / intern / all only (1.1.0+).
 *
 * career.huawei.com/reccampportal is structurally campus-only. Probed
 * 2026-05-20:
 *   - `jobType=SOCIAL` → HTTP 405 Jalor framework "Anonymous" error.
 *   - `jobType=EXPERIENCED` → 200 OK but silently treated as `jobType=3`
 *     (all-campus-types), returns the IDENTICAL 4076-row payload as
 *     `jobType=3`. Identifier is not recognised as a real social channel.
 * No /social/ subroute exists on the portal. Huawei recruits social hires
 * externally (招聘.huawei.com / hrlink — separate stack), so the
 * dispatcher must fail fast for `--scope social`.
 *
 * Scope translation to `recruitType`:
 *   campus    → "newgrad"   (jobType=0, jobTypes=2)  ← historical default
 *   intern    → "intern"    (jobType=0, jobTypes=0)
 *   all       → "all"       (jobType=3)
 *   undefined → unchanged   (preserves 1.0.93 behaviour)
 */
export const supportedScopes = ["campus", "intern", "all"];
function recruitTypeForScope(s) {
    if (s === "campus")
        return "newgrad";
    if (s === "intern")
        return "intern";
    if (s === "all")
        return "all";
    return undefined;
}
const PORTAL_ROOT = "https://career.huawei.com/reccampportal";
const API_ROOT = `${PORTAL_ROOT}/services/portal/portalpub`;
const USER_API_ROOT = `${PORTAL_ROOT}/services/portal/portaluser`;
const CAMPUS_PAGE = `${PORTAL_ROOT}/portal5/campus-recruitment.html`;
const DETAIL_PAGE = (jobId, dataSource) => `${PORTAL_ROOT}/portal5/campus-recruitment-detail.html?jobId=${encodeURIComponent(jobId)}&dataSource=${encodeURIComponent(dataSource)}`;
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: CAMPUS_PAGE,
};
// ---------- session bootstrap ----------
// Huawei sets JSESSIONID on first GET to /reccampportal/. The public endpoints
// work without a session, but passing one avoids cookie-challenged 403s.
// Cache the session token for the lifetime of the process.
let _session = null;
async function getSession() {
    if (_session !== null)
        return _session;
    try {
        const resp = await fetch(`${PORTAL_ROOT}/`, {
            headers: DEFAULT_HEADERS,
            redirect: "follow",
        });
        const setCookie = resp.headers.get("set-cookie") ?? "";
        const match = setCookie.match(/JSESSIONID=([^;]+)/);
        _session = match ? match[1] : "";
        return _session;
    }
    catch {
        _session = "";
        return _session;
    }
}
// ---------- low-level GET helper ----------
async function getJson(url, params = {}) {
    const session = await getSession();
    // Build query string from params
    const qs = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== "" && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
    const fullUrl = qs ? `${url}?${qs}` : url;
    const headers = { ...DEFAULT_HEADERS };
    if (session)
        headers["Cookie"] = `JSESSIONID=${session}`;
    let response;
    try {
        response = await fetch(fullUrl, { headers });
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
// Maps (jobType, jobTypes) param values → human-readable label
const RECRUIT_LABELS = {
    "0/2": "应届生",
    "0/1": "留学生",
    "0/0": "实习生",
    "2/": "博士生",
    "0/-1": "博士生",
    "0/-2": "海外博士",
    "0/-3": "中方博士",
    "0/7": "海外本地",
    "0/": "应届生", // default
    "3/": "校园全类型",
};
function getRecruitLabel(jobType, jobTypes) {
    const key = `${jobType}/${jobTypes ?? ""}`;
    return RECRUIT_LABELS[key] ?? `jobType=${jobType}`;
}
function summarizePosition(item, recruitLabel) {
    const id = String(item.jobId ?? "");
    const ds = String(item.dataSource ?? "1");
    return {
        post_id: id,
        title: item.jobname ?? "",
        project: item.jobFamilyName ?? "",
        recruit_label: recruitLabel,
        bgs: "",
        work_cities: item.jobArea ?? item.jobAddress ?? "",
        apply_url: id ? DETAIL_PAGE(id, ds) : CAMPUS_PAGE,
    };
}
function resolveJobTypeParams(recruitType) {
    switch (recruitType) {
        case "overseas": return { jobType: "0", jobTypes: "1", label: "留学生" };
        case "intern": return { jobType: "0", jobTypes: "0", label: "实习生" };
        case "phd": return { jobType: "2", jobTypes: undefined, label: "博士生" };
        case "all": return { jobType: "3", jobTypes: undefined, label: "校园全类型" };
        case "newgrad":
        default: return { jobType: "0", jobTypes: "2", label: "应届生" };
    }
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(50, opts.pageSize ?? 15));
    const page = Math.max(1, opts.page ?? 1);
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    // scope (1.1.0+) wins over recruitType only when explicit recruitType is absent.
    const effectiveRecruitType = opts.recruitType ?? recruitTypeForScope(opts.scope);
    const { jobType, jobTypes, label } = resolveJobTypeParams(effectiveRecruitType);
    const params = {
        jobType,
        language: "zh_CN",
        reqTime: Date.now(),
        orderBy: "ISS_STARTDATE_DESC_AND_IS_HOT_JOB",
        pageSize,
        curPage: page,
    };
    if (jobTypes !== undefined)
        params.jobTypes = jobTypes;
    if (keyword)
        params.searchText = keyword;
    if (opts.jobFamClsCode)
        params.jobFamClsCode = opts.jobFamClsCode;
    if (opts.cityCode)
        params.cityCode = opts.cityCode;
    const url = `${API_ROOT}/getJob/newHr/page/${pageSize}/${page}`;
    const resp = await getJson(url, params);
    if (!resp.ok || !resp.data) {
        return {
            ok: false,
            source: "career.huawei.com",
            message: resp.message,
            query: params,
            page,
            page_size: pageSize,
            total: 0,
            positions: [],
        };
    }
    const pv = resp.data.pageVO ?? {};
    const items = resp.data.result ?? [];
    const recruitLabel = getRecruitLabel(jobType, jobTypes);
    return {
        ok: true,
        source: "career.huawei.com",
        query: params,
        page,
        page_size: pageSize,
        total: pv.totalRows ?? items.length,
        positions: items.map((item) => summarizePosition(item, recruitLabel)),
        _label: label,
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(50, opts.pageSize ?? 50));
    const maxPages = Math.max(1, opts.maxPages ?? 10);
    const bucket = [];
    let total;
    for (let page = 1; page <= maxPages; page++) {
        const result = await searchPositions({ ...opts, page, pageSize });
        if (!result.ok) {
            return {
                ok: false,
                source: "career.huawei.com",
                message: result.message,
                total: total ?? 0,
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
        source: "career.huawei.com",
        total: total ?? bucket.length,
        fetched: bucket.length,
        positions: bucket,
    };
}
// ---------- fetchPositionDetail ----------
// Uses two endpoints:
//   1. getJobDetail (flat metadata + possibly placeholder JD text)
//   2. findIntentListByJobRequirementId (full JD per sub-position intent)
//
// post_id = item.jobId from searchPositions results.
// If the caller has item.jobRequirementId it can be passed as opts.jobRequirementId
// for the intent-list fetch; otherwise it's extracted from the getJobDetail response.
export async function fetchPositionDetail(postId, opts = {}) {
    const id = (postId ?? "").trim();
    if (!id) {
        return { ok: false, source: "career.huawei.com", message: "post_id is required" };
    }
    const ds = opts.dataSource ?? "1";
    const detailUrl = `${API_ROOT}/getJobDetail/newHr`;
    const detailResp = await getJson(detailUrl, {
        jobId: id,
        dataSource: ds,
        language: "zh_CN",
    });
    if (!detailResp.ok || !detailResp.data) {
        return {
            ok: false,
            source: "career.huawei.com",
            post_id: id,
            message: detailResp.message,
        };
    }
    const raw = detailResp.data;
    // Fetch intent list for the full JD (jobResponsibilities + jobDemand)
    const reqId = opts.jobRequirementId ?? String(raw.jobRequirementId ?? "");
    let intents = [];
    if (reqId) {
        const intentUrl = `${USER_API_ROOT}/findIntentListByJobRequirementId/newHr/zh_CN/${encodeURIComponent(reqId)}/null`;
        const intentResp = await getJson(intentUrl, { dataSource: ds, jobId: id });
        if (intentResp.ok && Array.isArray(intentResp.data)) {
            intents = intentResp.data;
        }
    }
    // Strip HTML tags from JD text
    const stripHtml = (s) => (s ?? "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();
    // Determine description: prefer intent list if main description is a placeholder
    const isPlaceholder = (s) => !s || s.includes("请您详见岗位意向");
    const mainBusiness = raw.mainBusiness ?? "";
    const jobRequire = raw.jobRequire ?? "";
    let description = isPlaceholder(mainBusiness)
        ? intents.map((i) => `【${i.positionIntention ?? ""}】\n${stripHtml(i.jobResponsibilities)}`).join("\n\n")
        : mainBusiness;
    let requirements = isPlaceholder(jobRequire)
        ? intents.map((i) => `【${i.positionIntention ?? ""}】\n${stripHtml(i.jobDemand)}`).join("\n\n")
        : jobRequire;
    description = description.trim();
    requirements = requirements.trim();
    return {
        ok: true,
        source: "career.huawei.com",
        post_id: id,
        job_requirement_id: reqId,
        title: raw.jobname ?? "",
        direction: "",
        project: raw.jobFamilyName ?? "",
        description,
        requirements,
        work_cities: raw.jobArea ?? raw.jobAddress ?? "",
        recruit_cities: [],
        intents: intents.map((i) => ({
            id: i.positionIntentionId ?? "",
            title: i.positionIntention ?? "",
            dept: i.deptName ?? "",
            cities: i.jobPlaceName ?? i.jobPlace ?? "",
            description: stripHtml(i.jobResponsibilities),
            requirements: stripHtml(i.jobDemand),
        })),
        apply_url: DETAIL_PAGE(id, ds),
    };
}
// ---------- fetchDictionaries ----------
// There is no public filter-taxonomy endpoint (list/lang returns 403; findStatAddress
// returns 404 without a login session). This stub documents the known static
// values as observed in the JS bundle and probed API responses (2026-05).
export async function fetchDictionaries() {
    // Probe the portal to confirm it is reachable
    const session = await getSession();
    const reachable = session !== null;
    return {
        ok: true,
        source: "career.huawei.com",
        note: "Huawei: no public filter-taxonomy endpoint. " +
            "/services/portal/portalpub/list/lang/ returns 403 without login; " +
            "findStatAddress/ returns 404. Values below are static from JS bundle (2026-05).",
        reachable,
        // jobTypes semantics from campus-recruitment.html Vue component
        recruit_types: [
            { jobType: "0", jobTypes: "2", label: "应届生 (new-grad)", approx_count: 60 },
            { jobType: "0", jobTypes: "1", label: "留学生 (overseas student)", approx_count: 40 },
            { jobType: "0", jobTypes: "0", label: "实习生 (intern/博士)", approx_count: 30 },
            { jobType: "2", jobTypes: null, label: "博士生 (PhD)", approx_count: 92 },
            { jobType: "3", jobTypes: null, label: "全类型 (all campus)", approx_count: 420 },
        ],
        // Job family class codes observed in search results (2026-05)
        job_family_class_codes: [
            { code: "JFC1", approx: "研发族 (R&D)" },
            { code: "JFC2", approx: "销售族 (Sales) / 其他 (Other)" },
        ],
        // Job family codes observed in results
        job_families: [
            { code: "J01", name: "软件工程族" },
            { code: "J03", name: "销售族" },
            { code: "J26", name: "研发族" },
        ],
        // Key work cities appear in item.jobArea as Chinese strings like "中国/深圳"
        city_note: "Cities are returned in item.jobArea as Chinese strings (e.g. '中国/深圳,中国/上海'). " +
            "Use cityCode param to filter; codes appear in item.cityCode when set.",
    };
}
// ---------- stub notices ----------
// Huawei: no public notice/announcement endpoint found.
const STUB_NOTICE_RESULT = {
    ok: false,
    source: "career.huawei.com",
    message: "Huawei: no public notices endpoint",
};
export async function listNotices() {
    return STUB_NOTICE_RESULT;
}
export async function getNotice(_id) {
    return {
        ok: false,
        source: "career.huawei.com",
        message: "Huawei: no public notices endpoint",
    };
}
export async function findNoticesByQuestion(_question, _opts = {}) {
    return {
        ok: false,
        source: "career.huawei.com",
        message: "Huawei: no public notices endpoint",
    };
}
// ---------- matchResume ----------
// Mirror tencent/bytedance algorithm:
// 1. Extract signals from resume text.
// 2. Search with top-3 terms as keyword (all-types pool for breadth).
// 3. Score each position against title + project + work_cities blob.
// 4. Enrich top candidates with full detail + intent JD for deeper scoring.
// 5. Return top N matches with reasons.
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 20);
    const recruitType = opts.recruitType ?? "all";
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: "career.huawei.com",
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const keyword = terms.slice(0, 3).join(" ");
    const list = await searchPositions({ keyword, page: 1, pageSize: 50, recruitType });
    if (!list.ok) {
        return {
            ok: false,
            source: "career.huawei.com",
            message: list.message,
            positions: [],
        };
    }
    // If keyword search returns few results, fall back to no-keyword full list
    const pool = list.positions.length < 5
        ? (await searchPositions({ page: 1, pageSize: 50, recruitType })).positions
        : list.positions;
    const scored = [];
    for (const p of pool) {
        const blob = [p.title, p.project, p.recruit_label, p.work_cities].join(" ");
        const { score, reasons } = scoreOverlap(blob, terms, cities);
        if (score > 0)
            scored.push({ score, position: p, reasons });
    }
    scored.sort((a, b) => b.score - a.score);
    let shortlist = scored.slice(0, Math.max(topN, candidates));
    if (!shortlist.length) {
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
                detail.project,
                detail.description,
                detail.requirements,
                detail.work_cities,
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
        source: "career.huawei.com",
        extracted_terms: terms,
        city_preferences: cities,
        matches: enriched.slice(0, topN).map((e) => e.row),
        note: "match_reasons surfaces overlapping keywords, not a probability of getting an interview. " +
            "The only authority on selection is HR.",
    };
}
