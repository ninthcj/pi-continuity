# Iteration review

Reviewed 2026-09-12 against the installed Pi 0.85.1 documentation and public projects with durable coding-agent state:

- Pi uses JSONL session trees with `id`/`parentId`, explicit `/resume` and `/fork`, and granular extension lifecycle events. Its public extension hook can block `tool_call`, but `before_provider_request` only inspects or replaces a payload.
- Aider keeps standing constraints in conventions files, uses a bounded repository map, and supports explicit history restore and context dropping. We adopted the idea of explicit scoped workspace evidence, not a second codebase index.
- OpenHands separates an append-only event log from base state, restores conversations only when tool compatibility is valid, and pages older history lazily. We adopted the event/checkpoint split, restart-safe unknown operations, and strict checkpoint visibility; the core remains SQLite-first and single-writer.
- OpenHands and Pi both make the workspace/session boundary explicit. We therefore reject a resume when the selected workspace fingerprint changes instead of silently trusting Git HEAD.
- Oh My Pi's current memory backends separate heuristic memory guidance from current repository/user authority, scope recall per project, return clipped previews with explicit full reads, and run extraction/consolidation as best-effort background work. We adopted scoped bounded recall, explicit full claim reads, and the rule that memory cannot authorize a change; the claim ledger remains the authority for confirmed facts and conflicts.

Implemented iterations, in order:

1. Independent SQLite authority and content-addressed blobs.
2. Contract revision, user/host confirmation, epoch and scope gates.
3. Request manifests with bounded recent event selection and provider-shaped host adapter.
4. Operation intents, idempotent completed results, and unknown-on-restart behavior.
5. Ordered handoff state machine and two-phase checkpoint publication.
6. Inspect-only checkpoint reads, explicit strict/practical imports, and workspace fingerprints.
7. Real Pi extension using verified 0.85.1 hooks, read-only `/continuity` status/inspect/resume commands, and default-off mode.
8. SQLite `VACUUM INTO` backup plus referenced blob copies.
9. Workspace path containment, recovery-state provider gating, explicit confirmation actor checks, and credential-shaped field redaction.
10. Structured memory claims with normalized duplicate detection, informational conflicts, immutable claim-set snapshots, three-way merge proposals, merge commits with two parents, bounded scoped recall, portable bundles, and non-destructive compression views.
11. Git-free portable workspace snapshots backed by content-addressed blobs, with historical file reads independent of ext4, APFS, or NTFS native snapshot support.\n12. Native snapshot capability probing plus optional APFS/VSS integration (one VSS path for NTFS and ReFS), with portable-CAS fallback when privileges or filesystem support are unavailable.

The next useful layer is adapter code for the portable bundle format: each external system can map its own IDs and retrieval index onto claims while this store retains snapshots as the durable history. Embedding/vector retrieval and model-based consolidation can be added behind that adapter later. Compression should remain non-destructive: compact the context sent to a model, keep the full claim set and snapshots addressable, and read an older snapshot when current context is insufficient.

Sources: [Pi coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [Oh My Pi autonomous memory](https://github.com/can1357/oh-my-pi/blob/main/docs/memory.md), [Oh My Pi Mnemopi backend](https://github.com/can1357/oh-my-pi/blob/main/docs/mnemosyne-memory-backend.md), [Aider configuration](https://aider.chat/docs/aider_conf.html), [Aider repository map](https://aider.chat/docs/repomap.html), [OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence), and [OpenHands SDK architecture](https://docs.openhands.dev/sdk/arch/sdk).
