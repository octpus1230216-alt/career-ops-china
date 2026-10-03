// Generic Beisen Wecruit (北森 招聘云) adapter factory.
//
// Beisen Wecruit is one of two Beisen recruitment products we hit:
//   * Beisen iTalent  — hosted on `<tenant>.zhiye.com` (covered by vivo.ts /
//                       iflytek.ts / oppo.ts; envelope { Code, Data, Count }).
//   * Beisen Wecruit  — multi-tenant on `wecruit.hotjob.cn` and customer-owned
//                       hosts like `hr.sensetime.com`, `careers.<co>.com`.
//                       This module.
//
// Wecruit's distinguishing path is `/wecruit/...` at the host root. The
// public SPA bundles at `/{SU…}/pb/<channel>.html` are red herrings —
// every POST to that prefix returns nginx `405 Not Allowed`. The actual
// XHR the SPA fires is:
//
//   POST https://<host>/wecruit/positionInfo/listPosition/{SU…}
//        ?iSaJAx=isAjax&request_locale=zh_CN&t=<unix-ms>
//
//   Content-Type: application/x-www-form-urlencoded
//   Body: isFrompb=true&recruitType=<1|2>&pageSize=15&currentPage=1
//
// (Yes, form-urlencoded — not JSON — even though the response is JSON.)
//
// Response envelope:
//   { data:{ pageForm:{ totalPage, pageSize, pageData:[…], currentPage,
//                       dataCount }, positonNum },
//     state:"200", type:"success" }
//
// recruitType encoding: 1 = 校园 (campus / 应届 / 实习), 2 = 社招 (experienced).
// Each tenant has separate `SU…` channel ids per recruit type. See:
//   * `sensetime.ts`        — social `SU60fa3bdabef57c1023fc1cbc`
//   * `horizonrobotics.ts`  — school `SU6409ef49bef57c635fd390a6`,
//                             social `SU64819a4f2f9d2433ba8b043a`
//
// Probed 2026-05-16. Apply URL deep-links to the SPA detail route at
// `/{SU…}/pb/<channel>.html#/postDetail?postId=<postId>`.
//
// DETAIL ENDPOINT (probed 2026-07-11 via /pb/js/posDetail.js bundle):
//   POST https://<host>/wecruit/positionInfo/listPositionDetail/{SU…}
//        ?iSaJAx=isAjax&request_locale=zh_CN&t=<unix-ms>
//   Body: postId=<postId>&recruitType=<1|2>   (form-urlencoded)
//
//   Returns the full JD: `workContent` (主要职责) + `serviceCondition`
//   (任职要求) plus orgName/recruitNumStr/workPlaceStr/publish dates.
//   The lookup is global per tenant — querying a social postId through the
//   campus channel still returns the right record (verified 2026-07-11).
//   Unknown/closed postId → state:"1017", msg:"该职位招聘已经关闭…".
import { extractResumeSignals, scoreOverlap, checkResume, pickDistinctiveTerms } from "./tencent.js";
export { checkResume };
// ---------- factory ----------
export function createAdapter(cfg) {
    const SOURCE = cfg.host;
    const SITE_ROOT = `https://${cfg.host}`;
    const detailUrl = (channelId, pagePath, postId) => `${SITE_ROOT}/${encodeURIComponent(channelId)}/pb/${encodeURIComponent(pagePath)}.html#/postDetail?postId=${encodeURIComponent(postId)}`;
    const HEADERS = (channelId, pagePath) => ({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SITE_ROOT,
        Referer: `${SITE_ROOT}/${channelId}/pb/${pagePath}.html`,
        "X-Requested-With": "XMLHttpRequest",
    });
    function urlEncode(form) {
        const parts = [];
        for (const [k, v] of Object.entries(form)) {
            if (v === undefined)
                continue;
            parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
        return parts.join("&");
    }
    async function postChannel(channel, pageNum, pageSize, keyword) {
        const ts = Date.now();
        const url = `${SITE_ROOT}/wecruit/positionInfo/listPosition/${channel.channelId}?iSaJAx=isAjax&request_locale=zh_CN&t=${ts}`;
        const recruitType = channel.recruitType === "social" ? 2 : 1;
        const form = {
            isFrompb: true,
            recruitType,
            pageSize,
            currentPage: pageNum,
        };
        if (keyword)
            form.postName = keyword;
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                headers: HEADERS(channel.channelId, channel.pagePath),
                body: urlEncode(form),
            });
        }
        catch (err) {
            return { ok: false, message: `network error: ${err instanceof Error ? err.message : String(err)}` };
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
        if (payload.state !== "200" || !payload.data) {
            return { ok: false, message: payload.msg ?? `upstream state=${payload.state}` };
        }
        return { ok: true, pageForm: payload.data.pageForm, message: "ok" };
    }
    /**
     * Fetch the full JD via `listPositionDetail` (discovered 2026-07-11 in the
     * `/pb/js/posDetail.js` bundle — the standalone detail page's only data
     * XHR). Same form-urlencoded POST style as listPosition. Body carries
     * `postId` + `recruitType`; the lookup is tenant-global, so the first
     * channel that answers state=200 wins.
     */
    async function postDetail(channel, postId) {
        const ts = Date.now();
        const url = `${SITE_ROOT}/wecruit/positionInfo/listPositionDetail/${channel.channelId}?iSaJAx=isAjax&request_locale=zh_CN&t=${ts}`;
        const recruitType = channel.recruitType === "social" ? 2 : 1;
        let response;
        try {
            response = await fetch(url, {
                method: "POST",
                // The real SPA fires this from the standalone posDetail.html page.
                headers: HEADERS(channel.channelId, "posDetail"),
                body: urlEncode({ postId, recruitType }),
            });
        }
        catch (err) {
            return { ok: false, message: `network error: ${err instanceof Error ? err.message : String(err)}` };
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
        if (payload.state !== "200" || !payload.data) {
            // state "1017" = 该职位招聘已经关闭 (closed / unknown postId).
            return { ok: false, message: payload.msg ?? `upstream state=${payload.state}` };
        }
        return { ok: true, detail: payload.data, message: "ok" };
    }
    function summarize(item, channel) {
        const id = String(item.postId ?? "");
        const labelFromRecruitType = item.recruitmentType ?? (item.recruitType === 2 ? "社招" : item.recruitType === 1 ? "校园" : "");
        return {
            post_id: id,
            title: (item.postName ?? "").trim(),
            project: (item.postTypeName ?? "").trim(),
            recruit_label: labelFromRecruitType,
            bgs: (item.department ?? item.company ?? "").trim(),
            work_cities: (item.workPlaceStr ?? "").trim(),
            apply_url: id ? detailUrl(channel.channelId, channel.pagePath, id) : `${SITE_ROOT}/${channel.channelId}/pb/${channel.pagePath}.html`,
        };
    }
    function channelsForType(t) {
        if (!t || t === "all")
            return cfg.channels;
        return cfg.channels.filter((c) => c.recruitType === t);
    }
    /**
     * Translate the unified CLI `--scope` flag to this factory's `recruitType`
     * key. `intern` collapses to `campus` because Wecruit's recruitType=1
     * channel covers 校园 / 应届 / 实习 in one bucket. `social`, `campus`, and
     * `all` map 1:1 onto the existing recruitType domain.
     */
    function recruitTypeForScope(s) {
        if (s === undefined)
            return undefined;
        if (s === "intern")
            return "campus";
        return s;
    }
    /** Resolve effective recruitType, with `scope` winning over legacy `recruitType`. */
    function effectiveRecruitType(opts) {
        if (opts.scope !== undefined)
            return recruitTypeForScope(opts.scope);
        return opts.recruitType;
    }
    /**
     * Scopes this adapter can actually serve, derived from the configured
     * channels' `recruitType` values. `all` is always supported.
     */
    const supportedScopes = (() => {
        const set = new Set();
        for (const ch of cfg.channels) {
            if (ch.recruitType === "social")
                set.add("social");
            if (ch.recruitType === "campus")
                set.add("campus");
        }
        set.add("all");
        return Object.freeze([...set]);
    })();
    async function searchPositions(opts = {}) {
        const pageSize = Math.max(1, Math.min(50, opts.pageSize ?? 15));
        const page = Math.max(1, opts.page ?? 1);
        const keyword = (opts.keyword ?? "").trim().slice(0, 60);
        const channels = channelsForType(effectiveRecruitType(opts));
        if (!channels.length) {
            return {
                ok: false,
                source: SOURCE,
                message: `no channels match recruitType=${opts.recruitType ?? "all"}`,
                query: opts,
                positions: [],
            };
        }
        // For single-channel adapters this is one call. For multi-channel
        // (campus+social) we round-robin: we ask each channel for the same
        // page index and merge the resulting positions. Total reflects the
        // sum across channels.
        const positions = [];
        let total = 0;
        let lastMsg = "ok";
        let anyOk = false;
        for (const ch of channels) {
            const r = await postChannel(ch, page, pageSize, keyword);
            if (!r.ok || !r.pageForm) {
                lastMsg = r.message;
                continue;
            }
            anyOk = true;
            total += (r.pageForm.dataCount ?? 0) || (r.pageForm.totalPage ?? 0) * (r.pageForm.pageSize ?? 0);
            for (const p of r.pageForm.pageData ?? [])
                positions.push(summarize(p, ch));
        }
        if (!anyOk) {
            return {
                ok: false,
                source: SOURCE,
                message: lastMsg,
                query: opts,
                positions,
            };
        }
        return {
            ok: true,
            source: SOURCE,
            query: opts,
            page,
            page_size: pageSize,
            // page_size is applied *per channel*; a merged (scope=all) page can
            // therefore hold up to page_size × channels rows. Surface that so the
            // metadata never understates the row count (audit 1.1.14).
            channels: channels.length,
            ...(channels.length > 1
                ? {
                    page_size_note: `page_size applies per channel; a merged page may hold up to ${pageSize * channels.length} rows (${channels.length} channels)`,
                }
                : {}),
            total,
            positions,
        };
    }
    async function fetchAllPositions(opts = {}) {
        const pageSize = Math.max(1, Math.min(50, opts.pageSize ?? 15));
        const maxPages = Math.max(1, opts.maxPages ?? 30);
        const keyword = (opts.keyword ?? "").trim().slice(0, 60);
        const channels = channelsForType(effectiveRecruitType(opts));
        const bucket = [];
        const seen = new Set();
        let total = 0;
        let truncated = false;
        let lastMsg = "ok";
        let anyOk = false;
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        for (const ch of channels) {
            let chTotal;
            for (let page = 1; page <= maxPages; page++) {
                // Wecruit occasionally drops a page mid-run (observed 2026-07-11:
                // one run returned 255/271 rows). Back off and retry before giving
                // up, and never end a channel silently short — flag `truncated`.
                let r = await postChannel(ch, page, pageSize, keyword);
                for (let attempt = 1; (!r.ok || !r.pageForm) && attempt <= 2; attempt++) {
                    await sleep(500 * attempt);
                    r = await postChannel(ch, page, pageSize, keyword);
                }
                if (!r.ok || !r.pageForm) {
                    lastMsg = r.message;
                    truncated = true; // gave up before exhausting this channel
                    break;
                }
                anyOk = true;
                if (chTotal === undefined) {
                    // Prefer dataCount: it is the exact row count, whereas
                    // totalPage*pageSize rounds the last page up (audit 1.1.14 saw
                    // total=350 reported for 271 real positions).
                    chTotal = (r.pageForm.dataCount ?? 0) || (r.pageForm.totalPage ?? 0) * (r.pageForm.pageSize ?? 0);
                    total += chTotal;
                }
                const data = r.pageForm.pageData ?? [];
                if (!data.length)
                    break;
                let added = 0;
                for (const p of data) {
                    const s = summarize(p, ch);
                    if (s.post_id) {
                        if (seen.has(s.post_id))
                            continue;
                        seen.add(s.post_id);
                    }
                    bucket.push(s);
                    added++;
                }
                const totalPages = r.pageForm.totalPage ?? 0;
                // No new rows → upstream is repeating pages; stop rather than loop.
                if (!added) {
                    if (page < totalPages)
                        truncated = true;
                    break;
                }
                if (totalPages && page >= totalPages)
                    break;
                if (page === maxPages && totalPages > maxPages)
                    truncated = true;
            }
        }
        if (!anyOk) {
            return {
                ok: false,
                source: SOURCE,
                message: lastMsg,
                total: 0,
                fetched: bucket.length,
                positions: bucket,
            };
        }
        // Page drift (list reordering between page fetches) can silently hide
        // rows even when every request succeeded — never report a short result
        // as complete.
        if (bucket.length < total)
            truncated = true;
        return {
            ok: true,
            source: SOURCE,
            total,
            fetched: bucket.length,
            truncated,
            positions: bucket,
        };
    }
    async function fetchPositionDetail(postId) {
        const id = (postId ?? "").trim();
        if (!id)
            return { ok: false, source: SOURCE, message: "post_id is required" };
        // listPositionDetail carries the full JD (workContent + serviceCondition)
        // that the description-light listPosition endpoint never had. The lookup
        // is tenant-global, so the first channel that answers wins — one request
        // in the common case.
        let lastMsg = "no channels configured";
        for (const ch of cfg.channels) {
            const r = await postDetail(ch, id);
            if (!r.ok || !r.detail) {
                lastMsg = r.message;
                continue;
            }
            const found = r.detail;
            const summary = summarize(found, ch);
            const workContent = (found.workContent ?? "").trim();
            const serviceCondition = (found.serviceCondition ?? "").trim();
            const description = [workContent, serviceCondition].filter(Boolean).join("\n\n");
            return {
                ok: true,
                source: SOURCE,
                post_id: String(found.postId ?? id),
                title: found.postName ?? "",
                project: summary.project,
                recruit_label: summary.recruit_label,
                company: found.company ?? "",
                department: found.department ?? "",
                work_cities: found.workPlaceStr ?? "",
                recruit_num: found.recruitNumStr ?? "",
                page_views: found.pageViews ?? 0,
                publish_date: found.publishDate ?? found.publishFirstDate ?? "",
                end_date: found.endDate ?? "",
                /** 主要职责 + 任职要求, plain text. */
                description,
                work_content: workContent,
                service_condition: serviceCondition,
                apply_url: summary.apply_url,
            };
        }
        return {
            ok: false,
            source: SOURCE,
            post_id: id,
            message: `post ${id}: ${lastMsg}`,
        };
    }
    // ---------- fetchDictionaries ----------
    // Synthesize from one page per channel (postTypeName, workPlaceStr, etc.).
    let _dictCache = null;
    async function fetchDictionaries() {
        if (_dictCache !== null)
            return _dictCache;
        const types = new Set();
        const cities = new Set();
        const companies = new Set();
        const channelInfo = [];
        let anyOk = false;
        let lastMsg = "ok";
        for (const ch of cfg.channels) {
            const r = await postChannel(ch, 1, 50, "");
            if (!r.ok || !r.pageForm) {
                lastMsg = r.message;
                continue;
            }
            anyOk = true;
            // dataCount is exact; totalPage*pageSize rounds the last page up.
            const total = (r.pageForm.dataCount ?? 0) || (r.pageForm.totalPage ?? 0) * (r.pageForm.pageSize ?? 0);
            channelInfo.push({
                channelId: ch.channelId,
                recruitType: ch.recruitType,
                pagePath: ch.pagePath,
                total,
            });
            for (const p of r.pageForm.pageData ?? []) {
                if (p.postTypeName)
                    types.add(p.postTypeName);
                if (p.workPlaceStr)
                    cities.add(p.workPlaceStr);
                if (p.company)
                    companies.add(p.company);
            }
        }
        if (!anyOk) {
            const r = { ok: false, source: SOURCE, message: lastMsg };
            _dictCache = r;
            return r;
        }
        const result = {
            ok: true,
            source: SOURCE,
            channels: channelInfo,
            post_types: [...types].sort(),
            cities: [...cities].sort(),
            companies: [...companies].sort(),
        };
        _dictCache = result;
        return result;
    }
    // ---------- notices (stub) ----------
    const NOTICES_STUB = {
        ok: false,
        source: SOURCE,
        message: `${cfg.label}: Wecruit tenants have no public notices endpoint`,
    };
    async function listNotices() {
        return { ...NOTICES_STUB, notices: [] };
    }
    async function getNotice(noticeId) {
        return { ...NOTICES_STUB, notice_id: noticeId };
    }
    async function findNoticesByQuestion(question, _opts = {}) {
        return { ...NOTICES_STUB, question, matches: [] };
    }
    // ---------- matchResume ----------
    async function matchResume(text, opts = {}) {
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
        const lists = await Promise.all(queries.map((q) => searchPositions({ keyword: q, page: 1, pageSize: 50 })));
        const seen = new Set();
        const pool = [];
        let lastErr;
        for (const l of lists) {
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
            const broad = await searchPositions({ page: 1, pageSize: 50 });
            if (broad.ok)
                pool.push(...broad.positions);
        }
        if (!pool.length) {
            return { ok: false, source: SOURCE, message: lastErr ?? "no positions returned", positions: [] };
        }
        const scored = [];
        for (const p of pool) {
            const blob = [p.title, p.project, p.recruit_label, p.work_cities, p.bgs].join(" ");
            const { score, reasons } = scoreOverlap(blob, terms, cities);
            if (score > 0)
                scored.push({ score, position: p, reasons });
        }
        scored.sort((a, b) => b.score - a.score);
        let shortlist = scored.slice(0, Math.max(topN, candidates));
        if (!shortlist.length) {
            shortlist = pool.slice(0, candidates).map((position) => ({ score: 0, position, reasons: [] }));
        }
        const matches = shortlist.slice(0, topN).map((s) => {
            const mr = s.reasons.length > 0
                ? s.reasons.slice(0, 5)
                : ["no specific keyword overlap — surfaced from initial keyword search"];
            return { ...s.position, match_reasons: mr };
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
    return {
        supportedScopes,
        searchPositions,
        fetchAllPositions,
        fetchPositionDetail,
        fetchDictionaries,
        listNotices,
        getNotice,
        findNoticesByQuestion,
        matchResume,
        checkResume,
    };
}
