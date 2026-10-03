// Register the actual DSH settings bundle locally. No network/package runner,
// and no second compaction engine. Replaced links are kept in the backup.
import { existsSync,readFileSync,mkdirSync,symlinkSync,renameSync } from 'node:fs'
import { join } from 'node:path'
export function uiManifest(profile,stage) {
  const manifest=JSON.parse(profile.manifest)
  for(const section of ['dependencies','devDependencies','optionalDependencies'])if(manifest[section])delete manifest[section]['superlcm-mcp']
  manifest.dependencies={...manifest.dependencies,superlcm:'file:'+join(stage,'dsh/ui')}
  manifest.dsh.profile.bundles=[...manifest.dsh.profile.bundles.filter(n=>!['superlcm-mcp','SuperLcm','superlcm'].includes(n)),'superlcm']
  return manifest
}
export function linkUi(profile,stage,backup) {
  const file=join(profile.dir,'node_modules/superlcm'),saved=join(backup,profile.name+'-ui-link.before')
  mkdirSync(join(profile.dir,'node_modules'),{recursive:true})
  const existed=existsSync(file)
  if(existed){const metadata=JSON.parse(readFileSync(join(file,'package.json'),'utf8'));if(metadata.superlcmBridge!==true)throw Error('已有同名 superlcm 包，未覆盖');renameSync(file,saved)}
  symlinkSync(join(stage,'dsh/ui'),file,process.platform==='win32'?'junction':'dir')
  return {restore(){if(existsSync(file))renameSync(file,join(backup,profile.name+'-ui-link.failed'));if(existed)renameSync(saved,file)}}
}
