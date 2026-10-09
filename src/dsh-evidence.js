export const hasLegacyTable=db=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='dsh_legacy_sources'").get()
export function legacyDshSource(db,session){return hasLegacyTable(db)?db.prepare('SELECT version,sha256,sequence_mode,records,complete FROM dsh_legacy_sources WHERE session=?').get(session):null}
export function archivePosition(record){
 const meta=record.dsh_archive
 if(!meta)return record.event.seq
 if(meta.sequenceMode!=='physical-order'||!Number.isSafeInteger(meta.ordinal)||meta.ordinal<0||!Number.isSafeInteger(meta.sourceRow)||meta.sourceRow<1||meta.sourceSeq!==record.event.seq)throw Error('Invalid DSH historical position')
 return meta.ordinal
}
export const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value
export function mergeDshHeader(previous,incoming){
 const current={...incoming,delegationDepth:incoming.delegationDepth===undefined?0:incoming.delegationDepth}
 if(!previous)return canonical(current)
 const before={...previous,delegationDepth:previous.delegationDepth===undefined?0:previous.delegationDepth},after={...current};delete before.version;delete after.version
 if(before.agentPreset===undefined&&typeof after.agentPreset==='string')before.agentPreset=after.agentPreset
 if(after.agentPreset===undefined&&typeof before.agentPreset==='string')after.agentPreset=before.agentPreset
 if(JSON.stringify(canonical(before))!==JSON.stringify(canonical(after)))throw Error('DSH session identity changed; refusing to mix histories')
 return canonical({...previous,...current,...(current.agentPreset===undefined&&previous.agentPreset!==undefined?{agentPreset:previous.agentPreset}:{})})
}
