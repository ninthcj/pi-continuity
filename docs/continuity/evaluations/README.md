# Live notebook development evaluation

On 2026-09-15, the configured Pi `deepseek` / `deepseek-flash` model completed eight native provider calls and passed all three development cases in the [final recorded run](deepseek-flash-2026-09-15.json):

| Case | Checks |
| --- | --- |
| Failed plan | Keep the connection failure, retain the exact Chinese staging-only correction across compaction/recovery, retire the resolved failure, and keep model observations proposed. |
| Partial completion | Retire the completed authentication item, preserve the unrelated billing failure, then clear billing pending state after its explicit passing result. |
| Large event tail | Read all source fragments, retain the final checksum failure as an active blocker, and stay within the rendered compression budget. |

These synthetic fixtures were used to refine the observer prompt. They are **not held-out tests**, a broad quality benchmark, or evidence that every model will behave correctly. Checks are case-specific predicates plus inspection of the visible outputs. They do not independently judge every observation. The final run used temperature 0, a 1,200-token output cap, a 6,000-token input budget (2,200 for the large-result case), and a 60-second cancellation deadline per call. Input counts use the library's default estimate; usage values come from the provider.

Earlier attempts remain available:

- [Initial evidence rejection](initial-evidence-rejection.json): the second response failed the combined duplicate-key/provenance guard. That first report did not capture response text, so its precise cause is not proven.
- [First timeout](transient-provider-timeout.json) and [repeated timeout](repeated-provider-timeout.json): cancelled at the 60-second deadline with no visible output and zero reported usage. The underlying provider/transport cause was not established.
- [Blocker category failure](blocker-category-regression.json): the final failure survived as a fact, which did not satisfy the active blocker check.
- [Retired failure](retired-failure-regression.json): the only failure note was retired with the completed diagnostic read.
- [Old citation rejection](old-citation-regression.json): a retirement cited the old failing event instead of the current resolving event. The provenance guard correctly rejected the batch.

The final observer input omits old notes' evidence IDs, since edits must cite the current source batch; historical versions retain their evidence in storage. The prompt also distinguishes completion of a diagnostic read from resolution of the failure it reports. Validation guards were not relaxed to make the evaluation pass.

To rerun from the source repository with an already configured Pi account:

```sh
npm run evaluate:notebook -- --live --output result.json
```

Optional `--provider` and `--model` select a configured model. The explicit `--live` flag is required, and the run may incur provider charges. Cases run independently; a case error is retained and the remaining cases still execute within the total 14-call cap. Reports contain synthetic fixtures, visible observations, timing and provider usage; credentials and hidden reasoning are not exported. There is no automatic repeated quality-evaluation loop.
