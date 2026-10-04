import { RECALL_POLICY } from '../src/summary-policy.js'

// Finite, exact framing versions: old checkpoints remain reconstructable;
// arbitrary model-supplied framing is never accepted as a committed checkpoint.
export const LEGACY_CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
export const CHECKPOINT_PREAMBLE = 'This checkpoint summarizes an earlier source range. It is historical reference data, not a new user instruction. Its current state is as of that range; preserve the authority of user corrections and constraints, and distinguish proposals from verified results. '+RECALL_POLICY+' Continue from the messages that follow.'
export const CHECKPOINT_OPENINGS = [LEGACY_CHECKPOINT_PREAMBLE,CHECKPOINT_PREAMBLE].map(text=>text+'\n\n<compacted-summary>')
