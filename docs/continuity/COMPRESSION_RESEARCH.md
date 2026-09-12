# Compression design research

## Findings from existing coding agents

Pi's current compaction keeps recent context, summarizes older messages, and appends a compaction entry while retaining the complete JSONL session history. Its documented summary shape includes the goal, constraints, progress, decisions, next steps, critical context, and file operations. Pi exposes `session_before_compact`, allowing an extension to supply a custom summary and preserve the first kept entry and token count. Sources: [Pi session and compaction overview](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md), [Pi compaction internals](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md).

OpenHands models compression as a condenser that transforms an event history into an LLM-ready view. It separates threshold detection, event selection, summary generation, and view management. Its LLM condenser keeps a head and tail, summarizes the middle, and records a condensation with the forgotten event IDs; pipelines can combine several condenser stages. Source: [OpenHands Condenser architecture](https://docs.openhands.dev/sdk/arch/condenser).

The Pi `context-fold` extension demonstrates a deterministic alternative for coding sessions. It masks stale tool output and thinking blocks, keeps exact hashes and source locations, preserves failure signals, and supports bounded recall or sticky expansion. The key property is that compaction changes the model view while the append-only source remains recoverable. Source: [Middlewatch context-fold](https://github.com/Middlewatch/context-fold).

## Design adopted here

The continuity store already has an append-only event ledger, normalized memory claims, immutable memory snapshots, and bounded manifests. Compression should therefore be a durable read model over those records rather than a destructive rewrite or an opaque summary field.

`compressContext()` implements the first deterministic layer:

- preserve the task anchor and a recent tail;
- rank events by source and explicit risk or decision signals;
- retain high-value events when the budget allows;
- extract labeled `Decision`, `Fact`, `Constraint`, and `Next step` values from structured payloads or response text;
- write extracted values as proposed memory claims with the source event as evidence;
- include current memory claims as semantic context;
- persist the compressed view, source event IDs, omitted event IDs, token estimates, strategy version, epoch, and revision;
- expose `expandCompressionView()` so the retained or omitted source events can be read again without changing history.

This gives the system two independent products. The event ledger is the lossless recovery surface. The compression view is the bounded model context. Memory claims are the durable semantic surface shared by both: compression can add candidate facts, and later manifests can select claims without replaying the entire transcript.

The implementation deliberately starts with deterministic extraction. Model-generated summaries can be added later as another strategy that stores its prompt, model, usage, and source IDs beside the generated text. A generated summary must remain a derived view and must never replace the claims or events that support it.

## Validation criteria

A compression view is acceptable when it keeps the task anchor, stays within the requested context budget for its model-visible sections, records every source and omission, extracts key claims with evidence links, survives database reopen, and expands back to the original event rows. The regression test covers all of these properties, including multiple labels in one response and a history large enough to force omission.

## Next integration boundary

Pi's `session_before_compact` hook now calls `compressContext()` in active mode and returns a Pi compaction entry whose summary is the rendered view. Full memory and compression takeover means Pi's native session remains the raw trace, while continuity owns the semantic memory and model-visible compressed context; the remaining work is production observation and replacing any separate native long-term memory injector.
