# Background summary reliability

SuperLcm keeps the full original conversation and builds navigation summaries separately. This update addresses [#10](https://github.com/yu381792/superlcm/issues/10), [#11](https://github.com/yu381792/superlcm/issues/11), [#12](https://github.com/yu381792/superlcm/issues/12) and [#13](https://github.com/yu381792/superlcm/issues/13), reported by muxammadreza. Their proposals helped identify the problems; the changes have their own reproductions and permanent regression tests.

## Summary length and response handling

The learned request length is a soft prompt target. It no longer lowers the 6,000-character acceptance limit. Complete drafts within that limit can be saved even when longer than the requested target. Overshoot learning rises immediately when necessary and gradually relaxes after smaller responses; reasoning-only updates do not change the length ratio.

Responses still need actual successful completion evidence. Empty streams, interrupted streams, upstream errors and invalid responses have distinct safe diagnostics. Missing provider usage is reported as unknown, while a real zero remains zero. Provider text, credentials and original conversation content are excluded from error messages.

Every HTTP attempt, including parameter compatibility negotiation and quality repair, gets its own response deadline. Task cancellation applies across attempts and rejects late results. Both successful responses and HTTP 400 compatibility bodies have bounded, cancellable reads. JSON returned under a stream content type must pass the ordinary JSON completion checks; it cannot manufacture stream completion evidence.

## Durable queue and status

Background jobs are recorded in the archive database. The console distinguishes queued, starting, running, completed, failed, stopped and unexpectedly lost jobs. A job records its model, current source range, completed segments and safe failure reason. Its identity and writer ownership prevent an older worker from replacing the status of a newer run.

The shared database admits at most three simultaneous summary jobs by default, across cooperating processes using that database. Set `SUPERLCM_SUMMARY_CONCURRENCY` consistently for those processes to an integer from 1 through 16 to change the limit. Interactive conversations have priority over non-interactive Codex executions. Normal background workers, direct CLI writers and in-host claims participate in admission; DSH uses its own existing serial archive service.

The console adds **Needs attention** and **Non-interactive tasks** groups. Historical Codex classification reads the verified archive when the native log is unavailable. A failed job shows whether a later conversation turn or a manual action can retry it. Automatic retry remains bounded by the existing failed-batch cooldown, including workers using the old invocation protocol; a completed conversation may need a manual retry. Bulk retry requires a preview and explicit confirmation of the matching conversations and estimated summary work. The server rechecks the selection, settings, source range and estimate before queueing jobs.

A queued in-host job normally waits for another turn in its original conversation. If that conversation has ended, its detail page offers an explicit background-generation choice when a local CLI or API backend is available. Confirming that choice replaces only the unstarted in-host job; ordinary queued or running workers keep their existing job.

## Independent DSH plugin

[DSH SuperLcm 0.5.30](https://github.com/yu381792/dsh-superlcm/blob/main/docs/UPGRADE-0.5.30.md) shares the summary policy and completion checks. Its quality retries receive separate request deadlines, and empty output and interrupted output have different safe diagnostics. DSH settings and its serial scheduler remain managed inside the DSH plugin.

## Validation and limits

The release check runs regressions, the actual DSH runtime with synthetic model streams, unpacked npm CLI/MCP checks and package import verification. The DSH standalone check also exercises installation and upgrade through the official DSH CLI in an isolated macOS home containing spaces, Unicode and URL-significant characters. Tests check original retention, model/settings preservation, cancellation, late results, queue contention and status ownership without paid model calls.

The final full-version run passed 393 regression tests and 81 DSH runtime tests, followed by installed CLI/MCP and package checks. The standalone run passed 118 tests, followed by its official isolated install/upgrade and package checks. The full version adds 20 permanent tests for length/response handling and 29 for queue/status/classification and page actions.

An independent reviewer checks the changed paths and reproductions separately from implementation. The recorded platform is macOS. GitHub Actions remains disabled by the maintainer's choice; this release does not claim fresh Windows or Linux machine results. These tests verify the specified behavior and failure cases, rather than the semantic quality of every model's summaries.

After a Claude plugin update, reload the plugin in already open Claude sessions or start a new session. Existing local settings and archived originals are preserved.
