// Thin client for 米哈游 / miHoYo recruiting portal.
//
// Portal: https://jobs.mihoyo.com/   (the old campus.mihoyo.com permanently
//                                     redirects here)
// API host: https://ats.openout.mihoyo.com/ats-portal
//
// ============================================================
// Discovery (2026-05):
//
//   campus.mihoyo.com         → permanently redirects to jobs.mihoyo.com
//   jobs.mihoyo.com           → React SPA shell
//   ats.openout.mihoyo.com    → real ATS backend (in the bundle: baseURL)
//
//   The bundle whitelist contains /v1/job/category/list, /v1/job/get/id_list,
//   /v1/job/project_count/list — but the actual search endpoint that returns
//   summarized job rows (the one the SPA hits to render the list page) is
//   /v1/job/list (probed; unauth-OK with channelDetailIds + hireType + pageNo).
//   /v1/job/info gives full per-position detail.
//
//   "channel" semantics (decoded from the bundle's enums):
//     R.CAMPUS = 1, R.JOBS = 1 (same value), R.RECOMMEND = 2
//     hireType enum: JOBS = 0 (social), CAMPUS = 1
//   Default surface = social: channelDetailIds=[1], hireType=0.
//
// ============================================================
// Response shape (probed 2026-05):
//   data.list[]:
//     id, title, competencyType, jobNature, projectName,
//     addressDetailList[].addressDetail, channelDetailIds
//   data.total — canonical total count
//
// PositionSummary field mapping:
//   post_id       ← String(job.id)
//   title         ← job.title
//   project       ← job.competencyType  (job category)
//   recruit_label ← job.jobNature       ("全职" / "实习")
//   bgs           ← job.projectName     ("社会招聘" / "校园招聘")
//   work_cities   ← addressDetailList[].addressDetail joined " / "
//   apply_url     ← https://jobs.mihoyo.com/#/position/${id}
import { extractResumeSignals, scoreOverlap, checkResume } from "./tencent.js";
export { checkResume, extractResumeSignals, scoreOverlap };
/**
 * miHoYo supports social + campus + intern + all (1.1.0+). The upstream has
 * no intern-only enum — campus already lumps intern + new-grad — so `intern`
 * is mapped to `campus`.
 *
 * Scope translation to upstream (channelDetailIds, hireType):
 *   social  → ([1], 0)    (社招, default)
 *   campus  → ([2], 1)    (校招)
 *   intern  → ([2], 1)    (subset of campus)
 *   all     → ([1], 0)    (no merged feed — defaults to social)
 *   undefined → ([1], 0)  (historical default — social, preserves 1.0.93)
 */
export const supportedScopes = ["social", "campus", "intern", "all"];
function channelForScope(s) {
    if (s === "campus" || s === "intern")
        return { channelDetailIds: [1], hireType: 1 };
    // social / all / undefined → social defaults
    return { channelDetailIds: [1], hireType: 0 };
}
const SOURCE = "jobs.mihoyo.com";
const API_ROOT = "https://ats.openout.mihoyo.com/ats-portal";
const PORTAL_URL = "https://jobs.mihoyo.com";
const APPLY_URL_PREFIX = `${PORTAL_URL}/#/position`;
// Default channel: social ("社招"). Bundle constant R.JOBS = 1.
const CHANNEL_DETAIL_IDS = [1];
const HIRE_TYPE_SOCIAL = 0;
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
    Origin: PORTAL_URL,
    Referer: `${PORTAL_URL}/`,
};
async function postJson(path, body) {
    let response;
    try {
        response = await fetch(`${API_ROOT}${path}`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify(body),
        });
    }
    catch (err) {
        return { ok: false, message: `network error: ${err instanceof Error ? err.message : err}` };
    }
    if (!response.ok)
        return { ok: false, message: `HTTP ${response.status}` };
    let payload;
    try {
        payload = (await response.json());
    }
    catch (err) {
        return { ok: false, message: `bad JSON: ${err instanceof Error ? err.message : err}` };
    }
    if (payload.code !== 0 || !payload.data) {
        return { ok: false, message: payload.message || "upstream error" };
    }
    return { ok: true, data: payload.data, message: "ok" };
}
function summarize(row) {
    const id = String(row.id ?? "");
    const cities = (row.addressDetailList ?? [])
        .map((a) => a.addressDetail ?? "")
        .filter(Boolean);
    return {
        post_id: id,
        title: row.title ?? "",
        project: row.competencyType ?? "",
        recruit_label: row.jobNature ?? "",
        bgs: row.projectName ?? "",
        work_cities: cities.join(" / "),
        apply_url: id ? `${APPLY_URL_PREFIX}/${encodeURIComponent(id)}` : PORTAL_URL,
    };
}
// ---------- searchPositions ----------
export async function searchPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 20));
    const page = Math.max(1, opts.page ?? 1);
    const keyword = (opts.keyword ?? "").trim().slice(0, 60);
    const scopeChannel = channelForScope(opts.scope);
    const body = {
        channelDetailIds: opts.channelDetailIds ?? scopeChannel.channelDetailIds,
        hireType: opts.hireType ?? scopeChannel.hireType,
        pageSize,
        pageNo: page,
    };
    if (keyword)
        body.jobName = keyword;
    const response = await postJson("/v1/job/list", body);
    if (!response.ok || !response.data) {
        return {
            ok: false,
            message: response.message,
            source: SOURCE,
            query: body,
            positions: [],
        };
    }
    const rows = response.data.list ?? [];
    return {
        ok: true,
        source: SOURCE,
        query: body,
        page,
        page_size: pageSize,
        total: response.data.total ?? rows.length,
        positions: rows.map(summarize),
    };
}
// ---------- fetchAllPositions ----------
export async function fetchAllPositions(opts = {}) {
    const pageSize = Math.max(1, Math.min(100, opts.pageSize ?? 100));
    const maxPages = Math.max(1, opts.maxPages ?? 10);
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
export async function fetchPositionDetail(postId) {
    const id = (postId ?? "").trim();
    if (!id)
        return { ok: false, source: SOURCE, message: "post_id is required" };
    // /v1/job/info requires channelDetailIds (the channel mhy splits social /
    // campus / intern positions on); without it the API returns "职位渠道不可
    // 以为空" even for a valid post id.
    const response = await postJson("/v1/job/info", { id, channelDetailIds: CHANNEL_DETAIL_IDS });
    if (!response.ok || !response.data) {
        return { ok: false, source: SOURCE, message: response.message, post_id: id };
    }
    const d = response.data;
    const summary = summarize(d);
    return {
        ok: true,
        source: SOURCE,
        post_id: summary.post_id,
        title: d.title ?? "",
        direction: d.objectName ?? "",
        description: d.description ?? "",
        requirements: d.jobRequire ?? "",
        addition: d.addition ?? "",
        work_cities: d.addressDetailList ?? [],
        project: d.competencyType ?? "",
        recruit_label: d.jobNature ?? "",
        hire_type_name: d.hireTypeName ?? "",
        apply_url: summary.apply_url,
    };
}
// ---------- fetchDictionaries ----------
let _filterCache = null;
export async function fetchDictionaries() {
    if (_filterCache !== null)
        return _filterCache;
    const social = await postJson("/v1/job/category/list", {
        channelDetailIds: CHANNEL_DETAIL_IDS,
        hireType: HIRE_TYPE_SOCIAL,
    });
    const campus = await postJson("/v1/job/category/list", { channelDetailIds: CHANNEL_DETAIL_IDS, hireType: 1 });
    if (!social.ok && !campus.ok) {
        const result = {
            ok: false,
            source: SOURCE,
            message: social.message || campus.message,
        };
        _filterCache = result;
        return result;
    }
    const mapList = (list) => list.map((c) => ({
        competencyType: c.competencyType ?? "",
        competencyTypeName: c.competencyTypeName ?? "",
        competencyTypeEnName: c.competencyTypeEnName ?? "",
        count: c.count ?? 0,
    }));
    const result = {
        ok: true,
        source: SOURCE,
        categories_social: social.ok && social.data ? mapList(social.data) : [],
        categories_campus: campus.ok && campus.data ? mapList(campus.data) : [],
    };
    _filterCache = result;
    return result;
}
// ---------- stub notices ----------
const NOTICES_STUB = {
    ok: false,
    source: SOURCE,
    message: "miHoYo: no public notices endpoint",
};
export async function listNotices() {
    return { ...NOTICES_STUB, notices: [] };
}
export async function getNotice(noticeId) {
    return { ...NOTICES_STUB, notice_id: noticeId };
}
export async function findNoticesByQuestion(question, _opts = {}) {
    return { ...NOTICES_STUB, question, matches: [] };
}
// ---------- matchResume ----------
export async function matchResume(text, opts = {}) {
    const topN = Math.max(1, opts.topN ?? 5);
    const candidates = Math.max(topN, opts.candidates ?? 100);
    const { terms, cities } = extractResumeSignals(text ?? "");
    if (!terms.length) {
        return {
            ok: false,
            source: SOURCE,
            message: "could not extract any technical signals from the text",
            preview: (text ?? "").slice(0, 120),
        };
    }
    const keyword = terms[0];
    const list = await searchPositions({ keyword, page: 1, pageSize: Math.min(100, candidates) });
    if (!list.ok) {
        return { ok: false, source: SOURCE, message: list.message, positions: [] };
    }
    const scored = (list.positions ?? [])
        .map((p) => ({
        p,
        score: scoreOverlap(`${p.title} ${p.project} ${p.bgs}`, terms, cities).score,
    }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topN)
        .map((x) => x.p);
    return {
        ok: true,
        source: SOURCE,
        extracted_terms: terms,
        city_preferences: cities,
        matches: scored,
    };
}
