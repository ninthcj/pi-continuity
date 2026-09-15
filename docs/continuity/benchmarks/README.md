# Context compression measurements

Measured on 2026-09-15 with Windows, Node.js 24.19.0, Pi 0.85.1 and js-tiktoken 1.0.21. Both versions used the same synthetic diagnostic events and a 1,200-token compression budget. The tokenizer was warmed before timing; each size has one first compression and one repeat compression. Timings exclude database setup and fixture creation. These are individual same-machine samples, not statistical or production latency guarantees.

| Diagnostic events | 0.1.1 first / repeat (ms) | 0.1.2 first / repeat (ms) | First full token measurements, before → after |
| --- | --- | --- | --- |
| 64 | 233.4 / 216.8 | 52.9 / 28.4 | 64 → 10 |
| 256 | 2,466.1 / 2,456.0 | 95.7 / 60.6 | 256 → 13 |
| 1,024 | Not measured | 271.8 / 163.5 | Not measured → 14 |

For 256 events, characters passed through the full token counter fell from 32,173,730 to 539,785 on first compression. The 1,024-event repeat decoded three new audit events and extracted zero old events. All measured views retained the Chinese user correction and were independently checked against the actual rendered token count and budget.

The implementation uses a binary search over optional removal prefixes, final rendered-budget validation, bounded immutable event-text caching (8 MiB / 8,192 entries), and an incremental extraction cursor committed with the compression result. Required instructions, confirmed notes, and checkpoint/operation pending state still reject an impossible budget. Event metadata and required content can still grow; this is not a constant-memory or unlimited-history claim.

From the source repository:

```sh
npm run benchmark:context -- --events 64,256,1024 --output result.json
```

The same runner can load an independently installed older checkout with `--core /path/to/old/src/core.mjs`. The recorded baseline uses commit `81c5e5b49ee812ab02e039bfd281ced3b60356a4` (0.1.1).

Raw reports: [0.1.1 baseline](before-0.1.1.json) and [0.1.2 measurements](after-0.1.2.json).
