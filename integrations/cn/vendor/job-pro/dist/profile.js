// Read-only profile support (~/.jobpro/profile.json).
//
// The 1.x auto-apply surface owned profile creation and editing (`profile
// init/show/lint` lived in the dispatcher; the loader lived in apply.ts).
// 1.2.0 removed that surface, but two read-side behaviours still depend on
// the file when it exists:
//
//   * `match` / `resume-check` fall back to `profile.resume_path` when the
//     caller omits `--resume` and passes no inline text.
//   * `match` reads `profile.degree` to annotate degree-requirement fit.
//   * `status` reports whether the profile / its resume_path are usable.
//
// The CLI never writes this file anymore — users manage it by hand (or it
// survives from a pre-1.2.0 install).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
const PROFILE_PATH = process.env.JOB_PRO_PROFILE_PATH ?? join(homedir(), ".jobpro", "profile.json");
/**
 * Read profile.json as-is, returning whatever is there. No field validation —
 * callers only pick the keys they need (resume_path / degree).
 */
export function loadProfileRaw() {
    if (!existsSync(PROFILE_PATH)) {
        return { ok: false, path: PROFILE_PATH, message: `profile not found at ${PROFILE_PATH}` };
    }
    try {
        const raw = readFileSync(PROFILE_PATH, "utf8");
        return { ok: true, path: PROFILE_PATH, profile: JSON.parse(raw) };
    }
    catch (err) {
        return { ok: false, path: PROFILE_PATH, message: `could not parse ${PROFILE_PATH}: ${err instanceof Error ? err.message : err}` };
    }
}
/** Where the profile lives (env-overridable) — surfaced by `status`. */
export function profilePath() {
    return PROFILE_PATH;
}
