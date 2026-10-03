// 顺丰 (SF Express) recruiting adapter for `job-pro`.
//
// ============================================================
// API DISCOVERY — CAMPUS feed (probed 2026-05-15)
//
// campus.sf-express.com is a Vue SPA built with Webpack. The campus-recruiting
// flow was originally believed to be GeeTest-gated (POST /api/zp/jobList → 401),
// but the SPA's actual position-listing chunk (cr/static/js/25.aa149bcb...js)
// calls a different, fully anonymous route:
//
//   GET /api/web/position/query?pageNum=&pageSize=&keyword=…
//
// Required headers: a normal browser UA plus the `cr-service` header that the
// SPA's axios interceptor adds to every request. The interceptor sets
//   cr-service: <url-encoded current location>
// and the gateway uses it instead of a JWT to scope the response. With both
// in place the endpoint returns paginated JSON without any captcha or login.
//
// Endpoint inventory (anonymous GET unless noted):
//   GET /api/web/position/query        → paginated positions (campus + intern + mgmt)
//   GET /api/web/position/findById/<id>→ single posting (via /api/position/findById/<id>)
//
// `positionType` filter values seen in the wild:
//   "consulting"     管理咨询生
//   "managetraniee"  管培生类
//   "" (omitted)     全部
//
// CAVEAT: the `seasonType` query param on /api/web/position/query is
// server-side IGNORED (probed 2026-05-20: seasonType=1..9 plus "" all return
// the same 132-position payload). The campus feed itself only contains rows
// with seasonType:"1" (校招) and "3" (管培). Filtering by recruit channel
// therefore happens client-side or via the SOCIAL endpoint below.
//
// ============================================================
// API DISCOVERY — SOCIAL feed (probed 2026-05-20, worktree J)
//
// SF's social-hire portal lives at a completely different stack:
//
//   https://hr.sf-express.com/                — JSP/Spring portal (顺丰人才招聘系统-社会招聘)
//   POST   /SearchJob.do                       → paginated社招 list (anon)
//   GET    /JobSearchById/<id>,<positionType>  → social position detail page
//   GET    /jobMainHandlerT/main?jobType=…&outName=…  → HTML search results
//
// `/SearchJob.do` accepts a JSON body { workAddress, currentPage, outName,
// category, identification } and returns
//   { JobSearchList: { totalResult, totalPage, currentPage, listObj:[…] } }
// where each listObj row has id / outName (display title) / jobName /
// positionType (1/2/3 = 一线/二线/三线 grade) / positionTypeTxt / workAddress
// (city) / mainDuty / positionReq / educationReqTxt / workYearTxt /
// salaryRangeTxt / publishTime. ~1,976 active social positions at probe time.
//
// Required headers: standard browser UA + Content-Type:application/json. No
// CSRF / cookie / captcha is enforced for read-only browsing. The page size
// is fixed server-side at 10 rows per call (showCount:10), and the
// `pageSize`/`showCount` field passed in the body is ignored.
//
// Other discovered routes on hr.sf-express.com (anon-readable):
//   /index, /index.jsp, /jobMainHandler/main/<category>,
//   /jobMainHandlerT/main?jobType=<id>&outName=<keyword>,
//   /SearchDynamicHandler/<page>/job, /SearchSiteHandler/<page>/job,
//   /loginHandler.do, /registerHandler.do (apply flow — out of scope).
//
// Subdomains probed and ruled out:
//   career.sf-express.com / careers.sf-express.com / social.sf-express.com /
//   work.sf-express.com / join.sf-express.com / recruit.sf-express.com /
//   experience.sf-express.com / employee.sf-express.com / careers-social.sf-express.com
//   → all either DNS-fail or "Empty reply from server". Only campus.sf-express.com
//   (校招) and hr.sf-express.com (社招) are live.
// ============================================================
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume };
/**
 * SF Express supports social + campus + intern + all (1.1.0+).
 *
 * Scope translation to upstream feed:
 *   social  → POST hr.sf-express.com/SearchJob.do        (~1976 posts, 社招)
 *   campus  → GET campus.sf-express.com/api/web/position/query
 *   intern  → GET campus.sf-express.com/api/web/position/query (server seasonType
 *             filter is ignored; full mixed feed returned for now — client-side
 *             narrowing by internType is the caller's responsibility)
 *   all     → fan out both endpoints and merge
 *   undefined → campus.sf-express.com feed (historical default, preserves 1.0.93)
 */
export const supportedScopes = ["social", "campus", "intern", "all"];
const SOURCE = "campus.sf-express.com";
const API_ROOT = "https://campus.sf-express.com";
const SITE_ROOT = "https://campus.sf-express.com/";
const DETAIL_PAGE = (id) => `https://campus.sf-express.com/#/postDetail/${encodeURIComponent(id)}`;
const CR_SERVICE = "https%3A%2F%2Fcampus.sf-express.com%2F";
const DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: SITE_ROOT,
    Origin: API_ROOT,
    "cr-service": CR_SERVICE,
};
async function call(path, query = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== "")
            params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${API_ROOT}${path}${qs ? `?${qs}` : ""}`;
    let response;
    try {
        response = await fetch(url, { method: "GET", headers: DEFAULT_HEADERS });
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
    // SF returns the payload object directly (PageHelper shape: {list, total, …})
    let payload;
    try {
        payload = (await response.json());
    }
    catch (err) {
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : err}` };
    }
    return { ok: true, data: payload.list, total: payload.total, message: "ok" };
}
function summarize(item) {
    const id = String(item.id ?? "");
    const city = (item.demandCity ?? item.recruitCity ?? "").toString().trim();
    return {
        post_id: id,
        title: (item.positionName ?? "").trim(),
        project: (item.orgSourceName ?? item.orgSource ?? "").trim(),
        recruit_label: item.seasonType === "1"
            ? "校招"
            : item.seasonType === "2"
                ? "实习"
                : item.seasonType === "3"
                    ? "管培"
                    : "",
        bgs: (item.positionTypeName ?? "").trim(),
        work_cities: city,
        apply_url: id ? DETAIL_PAGE(id) : SITE_ROOT,
    };
}
// ---------- social feed (hr.sf-express.com) ----------
const SOCIAL_SOURCE = "hr.sf-express.com";
const SOCIAL_API_ROOT = "https://hr.sf-express.com";
const SOCIAL_SITE_ROOT = "https://hr.sf-express.com/";
// `/JobSearchById/<id>,<positionType>` is the human-facing detail page used by
// the SF social-hire portal. positionType (1/2/3) controls which template
// renders the page but is not used as a security gate.
const SOCIAL_DETAIL_PAGE = (id, positionType = 3) => `https://hr.sf-express.com/JobSearchById/${encodeURIComponent(id)},${encodeURIComponent(String(positionType))}`;
const SOCIAL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json;charset=UTF-8",
    Referer: "https://hr.sf-express.com/jobMainHandlerT/main?jobType=9999",
    Origin: SOCIAL_API_ROOT,
};
function summarizeSocial(item) {
    const id = String(item.id ?? "");
    const displayTitle = (item.outName ?? item.jobName ?? "").toString().trim();
    return {
        post_id: id,
        title: displayTitle,
        project: (item.orgName ?? "").toString().trim(),
        recruit_label: "社招",
        bgs: (item.positionTypeTxt ?? "").toString().trim(),
        work_cities: (item.workAddress ?? "").toString().trim(),
        apply_url: id ? SOCIAL_DETAIL_PAGE(id, item.positionType ?? 3) : SOCIAL_SITE_ROOT,
    };
}
/**
 * POST hr.sf-express.com/SearchJob.do — server-paginated社招 list. Page size
 * is fixed at 10 server-side; the request body's `showCount` is ignored.
 */
async function searchSocialPositions(opts = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    const body = {
        workAddress: opts.workAddress ?? "",
        currentPage: page,
        outName: keyword,
        category: opts.category ?? "",
        identification: "",
    };
    let response;
    try {
        response = await fetch(`${SOCIAL_API_ROOT}/SearchJob.do`, {
            method: "POST",
            headers: SOCIAL_HEADERS,
            body: JSON.stringify(body),
        });
    }
    catch (err) {
        return {
            ok: false,
            source: SOCIAL_SOURCE,
            message: `network error: ${err instanceof Error ? err.message : String(err)}`,
            query: body,
            positions: [],
        };
    }
    if (!response.ok) {
        return {
            ok: false,
            source: SOCIAL_SOURCE,
            message: `HTTP ${response.status}: ${response.statusText}`,
            query: body,
            positions: [],
        };
    }
    let payload;
    try {
        payload = (await response.json());
    }
    catch (err) {
        return {
            ok: false,
            source: SOCIAL_SOURCE,
            message: `bad JSON: ${err instanceof Error ? err.message : err}`,
            query: body,
            positions: [],
        };
    }
    const wrapper = payload.JobSearchList ?? {};
    const rows = wrapper.listObj ?? [];
    return {
        ok: true,
        source: SOCIAL_SOURCE,
        query: body,
        page,
        page_size: wrapper.showCount ?? 10,
        total: wrapper.totalResult ?? rows.length,
        // Verified live: SearchJob.do fixes the page size at 10 server-side and
        // ignores any showCount/pageSize field in the body.
        ...(opts.pageSize !== undefined && opts.pageSize !== 10
            ? { note: "hr.sf-express.com fixes the page size at 10 server-side; --page-size has no effect on --scope social." }
            : {}),
        positions: rows.map(summarizeSocial),
    };
}
/**
 * Pick the upstream feed for a given CLI scope. `social` → hr.sf-express.com;
 * everything else (campus / intern / all / undefined) routes through
 * campus.sf-express.com. `all` is handled separately by fanning out both.
 */
function feedForScope(s) {
    if (s === "social")
        return "social";
    if (s === "all")
        return "all";
    return "campus"; // campus / intern / undefined → existing default
}
export async function searchPositions(opts = {}) {
    const feed = feedForScope(opts.scope);
    // social-only — route to hr.sf-express.com
    if (feed === "social") {
        return searchSocialPositions(opts);
    }
    // scope=all — fan out both feeds and concatenate one logical page.
    // Each feed paginates independently; we expose the union as positions[]
    // and sum totals so callers know the full pool size.
    if (feed === "all") {
        const [campusRes, socialRes] = await Promise.all([
            searchPositions({ ...opts, scope: "campus" }),
            searchPositions({ ...opts, scope: "social" }),
        ]);
        const positions = [
            ...(campusRes.ok ? campusRes.positions : []),
            ...(socialRes.ok ? socialRes.positions : []),
        ];
        const total = (campusRes.ok && typeof campusRes.total === "number" ? campusRes.total : 0) +
            (socialRes.ok && typeof socialRes.total === "number" ? socialRes.total : 0);
        return {
            ok: true,
            source: `${SOURCE}+${SOCIAL_SOURCE}`,
            query: { scope: "all", keyword: opts.keyword ?? "", page: opts.page ?? 1 },
            page: opts.page ?? 1,
            page_size: positions.length,
            total,
            positions,
        };
    }
    // Default (campus / intern / undefined) → campus.sf-express.com
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const query = {
        pageNum: page,
        pageSize,
    };
    if (opts.keyword)
        query.positionName = opts.keyword.trim().slice(0, 60);
    if (opts.positionType)
        query.positionType = opts.positionType;
    if (opts.seasonType)
        query.seasonType = opts.seasonType;
    // intern scope is a no-op server-side (seasonType filter is ignored). We
    // still echo it so the caller can see it in `query.scope` for traceability.
    const r = await call("/api/web/position/query", query);
    if (!r.ok) {
        return {
            ok: false,
            source: SOURCE,
            message: r.message,
            query,
            positions: [],
        };
    }
    const rows = r.data ?? [];
    return {
        ok: true,
        source: SOURCE,
        query,
        page,
        page_size: pageSize,
        total: r.total ?? rows.length,
        positions: rows.map(summarize),
    };
}
export async function fetchAllPositions(opts = {}) {
    const feed = feedForScope(opts.scope);
    // scope=all → walk both feeds in parallel and merge by `${source}|post_id`
    if (feed === "all") {
        const [campusRes, socialRes] = await Promise.all([
            fetchAllPositions({ ...opts, scope: "campus" }),
            fetchAllPositions({ ...opts, scope: "social" }),
        ]);
        const seen = new Set();
        const merged = [];
        for (const p of [
            ...(campusRes.positions ?? []),
            ...(socialRes.positions ?? []),
        ]) {
            const key = `${p.apply_url || p.post_id}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            merged.push(p);
        }
        const total = (campusRes.ok && typeof campusRes.total === "number" ? campusRes.total : 0) +
            (socialRes.ok && typeof socialRes.total === "number" ? socialRes.total : 0);
        const truncated = (campusRes.ok && campusRes.truncated === true) ||
            (socialRes.ok && socialRes.truncated === true);
        const childNotes = [
            campusRes.ok ? campusRes.note : undefined,
            socialRes.ok ? socialRes.note : undefined,
        ].filter((n) => Boolean(n));
        return {
            ok: true,
            source: `${SOURCE}+${SOCIAL_SOURCE}`,
            total,
            fetched: merged.length,
            truncated,
            ...(childNotes.length ? { note: childNotes.join(" ") } : {}),
            positions: merged,
        };
    }
    // scope=social — page through hr.sf-express.com/SearchJob.do (server fixes
    // page size at 10, so the full ~2200-post feed needs ~220 pages; the default
    // 50-page cap keeps the round-trip count modest and reports truncated:true
    // so callers know to raise --max-pages for a full crawl).
    if (feed === "social") {
        const maxPages = Math.max(1, opts.maxPages ?? 50);
        const SOCIAL_PAGE_SIZE = 10; // fixed server-side
        const seen = new Set();
        const bucket = [];
        let total;
        let pagesNeeded;
        let exhausted = false;
        let duplicatesRemoved = 0;
        for (let page = 1; page <= maxPages; page++) {
            const r = await searchSocialPositions({
                keyword: opts.keyword,
                page,
                workAddress: opts.workAddress,
                category: opts.category,
            });
            if (!r.ok) {
                return {
                    ok: false,
                    source: SOCIAL_SOURCE,
                    message: r.message,
                    total: 0,
                    fetched: bucket.length,
                    positions: bucket,
                };
            }
            if (total === undefined) {
                total = r.total;
                pagesNeeded = Math.max(1, Math.ceil((total ?? 0) / SOCIAL_PAGE_SIZE));
            }
            if (!r.positions.length) {
                exhausted = true; // upstream ran out of rows
                break;
            }
            // Dedupe by post_id across pages (live feed can shift between fetches).
            for (const p of r.positions) {
                if (p.post_id) {
                    if (seen.has(p.post_id)) {
                        duplicatesRemoved++;
                        continue;
                    }
                    seen.add(p.post_id);
                }
                bucket.push(p);
            }
            if (total !== undefined && bucket.length >= total) {
                exhausted = true;
                break;
            }
            if (pagesNeeded !== undefined && page >= pagesNeeded) {
                exhausted = true;
                break;
            }
        }
        const truncated = !exhausted;
        return {
            ok: true,
            source: SOCIAL_SOURCE,
            total: total ?? bucket.length,
            fetched: bucket.length,
            truncated,
            ...(duplicatesRemoved > 0 ? { duplicates_removed: duplicatesRemoved } : {}),
            ...(truncated
                ? {
                    note: `hr.sf-express.com pages by a server-fixed 10 rows; stopped at --max-pages ${maxPages} of ${pagesNeeded ?? "?"} pages — pass a larger --max-pages to fetch the rest`,
                }
                : {}),
            positions: bucket,
        };
    }
    // Default (campus / intern / undefined) — campus.sf-express.com
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 50));
    const maxPages = Math.max(1, opts.maxPages ?? 20);
    const seen = new Set();
    const bucket = [];
    let total;
    let exhausted = false;
    let duplicatesRemoved = 0;
    for (let page = 1; page <= maxPages; page++) {
        const r = await searchPositions({
            keyword: opts.keyword,
            page,
            pageSize,
            scope: opts.scope,
        });
        if (!r.ok) {
            return {
                ok: false,
                source: SOURCE,
                message: r.message,
                total: 0,
                fetched: bucket.length,
                positions: bucket,
            };
        }
        if (total === undefined)
            total = r.total;
        if (!r.positions.length) {
            exhausted = true;
            break;
        }
        for (const p of r.positions) {
            if (p.post_id) {
                if (seen.has(p.post_id)) {
                    duplicatesRemoved++;
                    continue;
                }
                seen.add(p.post_id);
            }
            bucket.push(p);
        }
        if (total !== undefined && bucket.length >= total) {
            exhausted = true;
            break;
        }
        if (r.positions.length < pageSize) {
            exhausted = true; // short page = last page
            break;
        }
    }
    return {
        ok: true,
        source: SOURCE,
        total: total ?? bucket.length,
        fetched: bucket.length,
        truncated: !exhausted,
        ...(duplicatesRemoved > 0 ? { duplicates_removed: duplicatesRemoved } : {}),
        ...(!exhausted
            ? { note: `stopped at --max-pages ${maxPages} before reaching total; pass --max-pages N to fetch the rest` }
            : {}),
        positions: bucket,
    };
}
// ---------- social detail (HTML scrape of hr.sf-express.com) ----------
//
// hr.sf-express.com has no JSON detail endpoint, but /JobSearchById/<id>,<t>
// is a fully SERVER-RENDERED JSP page (probed 2026-07-11): the JD lives in
// hidden inputs (posId / positionName / positionworkAddress /
// positionPositionType), <li>label：<i>value</i></li> rows (招聘人数 / 有效期 /
// 学历要求 / 经验要求 / 薪酬范围) and two
// <div class="job-detail-info"><h4>工作职责：</h4>…<pre>…</pre></div> blocks.
// A wrong <t> or an unknown id renders a 404-styled page (HTTP 200, title
// "顺丰人才招聘系统-404", no posId input), so we probe positionType 3 → 1 → 2
// until one renders. Verified: /JobSearchById/69297,3 renders the full JD
// while /JobSearchById/69297,1 and /JobSearchById/99999,3 both render the
// 404 page.
function decodeHtmlEntities(s) {
    return s
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}
function stripTags(s) {
    return decodeHtmlEntities(s.replace(/<[^>]+>/g, ""))
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}
function hiddenInputValue(html, id) {
    const m = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*value="([^"]*)"`));
    return m ? decodeHtmlEntities(m[1]).trim() : "";
}
function liFieldValue(html, label) {
    // e.g. <li>招聘人数：<i>1人</i></li>. 经验要求 uses an ASCII colon upstream.
    const m = html.match(new RegExp(`${label}[：:]\\s*<i>([\\s\\S]*?)</i>`));
    return m ? stripTags(m[1]).replace(/\s+/g, " ").trim() : "";
}
function preBlockValue(html, heading) {
    const m = html.match(new RegExp(`<h4>\\s*${heading}[：:]?\\s*</h4>[\\s\\S]*?<pre[^>]*>([\\s\\S]*?)</pre>`));
    return m ? stripTags(m[1]) : "";
}
/** Resolve a social (社招) post by scraping the server-rendered detail page.
 *  Returns null when no positionType template renders the id (= not a live
 *  social post). */
async function fetchSocialPositionDetail(id) {
    for (const positionType of [3, 1, 2]) {
        const url = SOCIAL_DETAIL_PAGE(id, positionType);
        let response;
        try {
            response = await fetch(url, {
                method: "GET",
                headers: {
                    "User-Agent": SOCIAL_HEADERS["User-Agent"],
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                },
            });
        }
        catch {
            continue;
        }
        if (!response.ok)
            continue;
        let html;
        try {
            html = await response.text();
        }
        catch {
            continue;
        }
        const posId = hiddenInputValue(html, "posId");
        if (!posId || posId !== id)
            continue; // 404-styled page → try next template
        return {
            ok: true,
            source: SOCIAL_SOURCE,
            post_id: posId,
            title: hiddenInputValue(html, "positionName"),
            recruit_label: "社招",
            position_type: hiddenInputValue(html, "positionPositionType"),
            description: preBlockValue(html, "工作职责"),
            requirements: preBlockValue(html, "岗位要求"),
            work_city: hiddenInputValue(html, "positionworkAddress"),
            headcount: liFieldValue(html, "招聘人数"),
            valid_until: liFieldValue(html, "有效期"),
            education: liFieldValue(html, "学历要求"),
            experience: liFieldValue(html, "经验要求"),
            salary_range: liFieldValue(html, "薪酬范围"),
            apply_url: url,
        };
    }
    return null;
}
// ---------- fetchPositionDetail ----------
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id)
        return { ok: false, source: SOURCE, message: "post_id is required", post_id: id };
    // The CLI's `detail` verb takes the first positional token as the post_id,
    // so `sf detail --scope social 69297` used to fire the literal "--scope" at
    // the campus API (which answered with an opaque HTTP 500). Catch flag-shaped
    // ids with a usage hint instead of a misleading upstream error.
    if (id.startsWith("-")) {
        return {
            ok: false,
            source: SOURCE,
            post_id: id,
            message: `invalid post_id ${JSON.stringify(id)} — flags go after the id: job-pro sf detail <post_id>`,
        };
    }
    // 1) Campus feed first (historical default). /api/position/findById/ is the
    // auth-gated internal route; /api/web/position/ is the public anon route the
    // SPA actually uses. Without the /web/ prefix this 401s.
    // NOTE: the campus API answers HTTP 500 (empty statusText) for ANY id it
    // does not know — including social post ids — so a campus failure falls
    // through to the social portal probe below instead of surfacing the raw 500.
    let campusFailure;
    const url = `${API_ROOT}/api/web/position/findById/${encodeURIComponent(id)}`;
    let response;
    try {
        response = await fetch(url, { method: "GET", headers: DEFAULT_HEADERS });
    }
    catch (err) {
        campusFailure = `network error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (response && !response.ok) {
        campusFailure = `HTTP ${response.status}`;
        response = undefined;
    }
    if (response) {
        let raw = null;
        try {
            raw = (await response.json());
        }
        catch (err) {
            campusFailure = `bad JSON: ${err instanceof Error ? err.message : err}`;
        }
        // Guard against an HTTP-200-but-empty body: only treat the campus answer
        // as a hit when it actually carries the position.
        if (raw && (raw.id !== undefined || raw.positionName)) {
            return {
                ok: true,
                source: SOURCE,
                post_id: String(raw.id ?? id),
                title: raw.positionName ?? "",
                project: raw.orgSourceName ?? raw.orgSource ?? "",
                position_type: raw.positionTypeName ?? "",
                description: (raw.postDuty ?? "").toString().trim(),
                requirements: (raw.jobRequirement ?? "").toString().trim(),
                work_city: raw.demandCity ?? "",
                interview_city: raw.recruitCity ?? "",
                education: raw.educationName ?? raw.education ?? "",
                intern_type: raw.internTypeName ?? raw.internType ?? "",
                create_date: raw.createDate ?? "",
                apply_url: DETAIL_PAGE(id),
            };
        }
        if (!campusFailure)
            campusFailure = "empty campus payload";
    }
    // 2) Social feed (hr.sf-express.com) — scrape the server-rendered page.
    const social = await fetchSocialPositionDetail(id);
    if (social)
        return social;
    // 3) Clean not-found instead of the upstream's opaque HTTP 500.
    return {
        ok: false,
        source: `${SOURCE}+${SOCIAL_SOURCE}`,
        post_id: id,
        message: `post ${id} not found in the campus (campus.sf-express.com) or social (hr.sf-express.com) feeds — ` +
            `it may have expired or never existed. ` +
            `(campus API said: ${campusFailure ?? "not found"}; it reports unknown ids as an opaque HTTP 500.)`,
    };
}
// ---------- fetchDictionaries (no public dict endpoint) ----------
export async function fetchDictionaries() {
    return {
        ok: false,
        source: SOURCE,
        message: "SF Express does not expose a public filter taxonomy endpoint; positions API accepts " +
            "positionName / positionType / seasonType query params directly.",
        api_host: API_ROOT,
        known_filters: {
            positionType: ["consulting", "managetraniee"],
            seasonType: { "1": "校招", "2": "实习", "3": "管培" },
        },
    };
}
// ---------- notices (no public notices endpoint) ----------
const NO_NOTICES = "SF Express campus does not expose a public notices/announcements endpoint.";
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
            source: opts.scope === "social" ? SOCIAL_SOURCE : SOURCE,
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
        source: opts.scope === "social"
            ? SOCIAL_SOURCE
            : opts.scope === "all"
                ? `${SOURCE}+${SOCIAL_SOURCE}`
                : SOURCE,
        extracted_terms: terms,
        city_preferences: cities,
        candidate_pool: all.positions.length,
        matches: scored.slice(0, topN).map((s) => s.position),
    };
}
export { extractResumeSignals, scoreOverlap };
