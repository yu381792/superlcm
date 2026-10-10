# Long autonomous turns and summary caching

This release addresses [#7](https://github.com/yu381792/superlcm/issues/7), [#8](https://github.com/yu381792/superlcm/issues/8) and [#9](https://github.com/yu381792/superlcm/issues/9), reported by **muxammadreza** with a concrete fork implementation. We reproduced the missing step observer and whole-turn retention before changing them.

## What went wrong

Previous regressions exercised short user turns, malformed model replies, archive integrity, install/update and cancellation. They did not represent a single autonomous Claude Code turn that fills the context before the next user prompt or Stop event. Background summaries then started too late; preserving two complete turns could retain almost the entire current context even after earlier work had been summarized. Dynamic depth, range and language instructions at the start of each prompt also prevented reuse of a substantial source prefix.

## Claude Code changes

- Observe main-session model steps without delaying or altering the event. Ingest and dispatch at most once per 45 seconds. Subagents and summary subprocesses remain excluded.
- Cover complete source batches before condensing older summaries. When the compaction needs only a few more completed batches, attempt a bounded catch-up: four leaf pieces, with a 75-second default deadline. Modes, configuration revisions, writer ownership and failure cooldown still apply.
- Split a very long turn at a verified assistant boundary with no unresolved tool results. The complete current human request is restored from the exact archived original, including text beyond the hook's 2,000-character preview. A source-record reference carries that same request through later compactions.
- Native continuations require their archived `isCompactSummary` flag and completed coverage. Quoting a continuation or SuperLcm packet is still an ordinary human request. Ambiguous boundaries and missing originals fall back safely.
- Aim for roughly one quarter of the configured window after replacement and reject a packet estimated above 35%. These are conservative local estimates, not provider billing counts. Oversized complete requests are retained through native compaction rather than silently truncated.
- Keep the last 50 sanitized compaction diagnostics per conversation, so the first plan, optional catch-up and inline fallback can be distinguished.

## Shared summary prompt changes

Static policy comes first, then literal historical source, then variable depth/range/language/size instructions. The closing reminder that the source is data remains last, including retries. A quality retry preserves the policy and source bytes. Existing summaries remain available and are not automatically regenerated.

Direct Anthropic API requests have explicit cache breakpoints on the system policy, common policy and source; variable job instructions remain outside those blocks. OpenAI requests keep the same stable source prefix and use their provider's implicit caching. This follows [Anthropic's prompt caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching). Cache reuse still depends on the provider, model, prefix size and lifetime; this release verifies request layout rather than claiming a measured live hit rate.

The shared prompt correction is also included in **DSH standalone 0.5.29**. Claude's step hooks and in-turn planner do not replace the DSH runtime. Both products preserve existing summary model, granularity and compaction choices.

## Verification scope

Full SuperLcm release verification passed 344 regression tests and 81 DSH runtime tests, plus installed CLI/MCP and package-import checks. DSH standalone passed 115 regressions, official isolated Mac installation/update and package-import checks. The paired core comparison matched all 11 modules.

Synthetic long turns, full requests, repeated compactions, native continuations, quoted packets, split/parallel tools, bounded catch-up, delayed model returns, settings changes and failure cooldown are regression-tested without paid model calls. Each repository's `npm run verify:release` additionally checks its real installed package and the Mac DSH host where applicable. Independent review probes the source and failure paths separately from implementation.

Independent review additionally reproduced and fixed four implementation mistakes before publication: a persisted synthetic packet incorrectly classified itself as human input; fixed character division underestimated dense Chinese request tokens; and reading Node `process.env` inside Claude's isolated module forced every attempt back to native; and accepting a missing claim identifier could let an old plugin instance save against a newer writer's claim. New claims now require their exact identifier for checks, saves, error reports, releases and handoff. Legacy migration rows retain narrowly scoped compatibility. Existing Claude sessions need a plugin reload after update. Permanent regressions use the real archive layout, the shared language-aware token estimator and a matching VM without Node globals.

These checks establish the tested behavior and installability. They do not establish that every model's generated summary preserves every implication of an arbitrary real task. Exact originals remain the authority for decisions and constraints.
