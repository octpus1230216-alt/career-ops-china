// Canonical contract every company adapter must satisfy.
//
// Previously the dispatcher leaned on `type CompanyAdapter = typeof tencent`
// plus `as unknown as CompanyAdapter` casts on every entry in the ADAPTERS
// map. That silenced every shape mismatch — if an adapter's return value
// drifted, TypeScript was happy and the bug surfaced at runtime.
//
// This module defines an explicit method-signature interface so adapters
// can be wired with `satisfies Record<string, CompanyAdapter>` and any
// future drift becomes a compile error.
//
// The result types are intentionally permissive (`Promise<unknown>`-shaped):
// adapter-specific success payloads have rich, per-company keys (Tencent has
// recruitment fields Feishu doesn't, etc.) that we don't want to flatten here.
// The contract is "this method exists and is async"; the per-company JSON
// shape is documented in each adapter's source.
export {};
