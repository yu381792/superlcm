import { mountCompactionOwner } from '../compaction-owner.js'
import * as Archive from '../archive.js'
import * as Settings from './index.js'

export const name = 'superlcm'

// One public DSH component owns the three internal responsibilities. The
// archive and settings bridge never register another compaction service.
export async function apply(ctx, config = {}) {
  const profile=ctx.get?.('profileContext')?.name
  // A newly created profile has not had its native policy captured or its
  // root compactor disabled. Keep native protection until it is connected.
  const eligible=!config.nativeConfigs||Object.hasOwn(config.nativeConfigs,profile)
  if(config.archiveOnly!==true&&eligible)await mountCompactionOwner(ctx, config)
  else if(!eligible)ctx.logger?.warn?.('新启动方式保留原生压缩，请先在 SuperLcm 后台重新接入')
  const archive = ctx.plugin(Archive, { archiveHome: config.archiveHome })
  await archive.await()
  const settings = ctx.plugin(Settings, { archiveHome: config.archiveHome,archiveOnly:config.archiveOnly })
  await settings.await()
}
