import { mountCompactionOwner } from '../compaction-owner.js'
import * as Archive from '../archive.js'
import * as Settings from './index.js'

export const name = 'superlcm'

// One public DSH component owns the three internal responsibilities. The
// archive and settings bridge never register another compaction service.
export async function apply(ctx, config = {}) {
  await mountCompactionOwner(ctx, config)
  const archive = ctx.plugin(Archive, { archiveHome: config.archiveHome })
  await archive.await()
  const settings = ctx.plugin(Settings, { archiveHome: config.archiveHome })
  await settings.await()
}
