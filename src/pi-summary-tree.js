// Pi uses the shared archive DAG and incremental fork planner. Native
// checkpoints carry references, not another independently evolving tree.
import {isDeepStrictEqual} from 'node:util'
import {forkHash} from './fork-summary.js'
import {saveForkTree} from './main-fork.js'

const hasTable=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const sorted=values=>[...new Set(values)].sort((a,b)=>a-b)
function sources(store,session,id){
  return hasTable(store.db,'dsh_node_sources')?store.db.prepare('SELECT seq FROM dsh_node_sources WHERE session=? AND id=? ORDER BY seq').all(session,id).map(r=>r.seq):[]
}
function archivedBlock(store,session,id){
  const node=store.node(session,id),sourceRecords=sources(store,session,id)
  if(!node||!sourceRecords.length)return null
  if(!Number.isSafeInteger(node.level)||node.level<0||sourceRecords[0]!==node.first||sourceRecords.at(-1)!==node.last)return null
  const children=JSON.parse(node.children).map(child=>store.node(session,child))
  if(children.some(child=>!child||child.level>=node.level))return null
  const visibility=hasTable(store.db,'dsh_shared_nodes')?store.db.prepare('SELECT visible FROM dsh_shared_nodes WHERE session=? AND id=?').get(session,id)?.visible:null
  return {archiveId:id,frozenSummary:node.summary,frozenLevel:node.level,kind:visibility===5?'snapshot':JSON.parse(node.children).length?'condensed':'leaf',sourceRecords}
}
function legacyFrontier(store,session,entry,byId){
  const tree=entry.details?.summaryTree,blocks=entry.details?.sourceBlocks
  if(!Array.isArray(tree)||!tree.length||!Array.isArray(blocks)||!blocks.length)return null
  const records=new Map(),active=new Set()
  const collect=index=>{
    if(records.has(index))return records.get(index)
    const node=tree[index]
    if(!node||node.index!==index||active.has(index))throw Error('Invalid legacy Pi tree')
    active.add(index)
    const values=node.children?.length?node.children.flatMap(collect):(blocks[index]?.entryIds||[]).map(id=>{
      const row=byId.get(id)
      if(!row||row.entry.type==='compaction')throw Error('Legacy Pi source cannot be expanded')
      return row.ordinal
    })
    if(!values.length)throw Error('Missing legacy Pi source')
    active.delete(index);records.set(index,sorted(values));return records.get(index)
  }
  const root=tree.at(-1),frontier=root.children?.length?root.children:[root.index]
  return frontier.map(index=>{
    const node=tree[index],expected=collect(index)
    const rows=store.db.prepare('SELECT id FROM nodes WHERE session=? AND summary=? AND first=? AND last=? AND level=?').all(session,node.summary,expected[0],expected.at(-1),node.semanticLevel??node.level)
    const found=rows.map(r=>archivedBlock(store,session,r.id)).find(n=>n&&isDeepStrictEqual(n.sourceRecords,expected))
    if(!found)throw Error('Legacy Pi archive node missing')
    return found
  })
}
export function piCheckpointBlocks(store,session,input,branch){
  const selected=new Set(input.sourceEntryIds||[]),candidates=branch.filter(e=>e.type==='compaction'&&selected.has(e.id))
  if(!candidates.length)return []
  const rows=store.eventRows(session).map(row=>({...row,entry:JSON.parse(store.exact(session,row.ordinal))})),byId=new Map(rows.filter(r=>r.entry.id).map(r=>[r.entry.id,r]))
  const checkpoints=[]
  for(const entry of candidates){
    let blocks
    const details=entry.details||{}
    try{if(details.summaryTreeFormat==='pi-incremental-v1'&&details.summaryDigest===forkHash(entry.summary)){
      const root=store.node(session,details.summaryRootId)
      if(root&&entry.summary.includes(root.summary)){
        const ids=details.summaryRootKind==='overview'?JSON.parse(root.children):[root.id]
        const found=ids.map(id=>archivedBlock(store,session,id))
        if(found.length&&found.every(Boolean))blocks=found
      }
    }else blocks=legacyFrontier(store,session,entry,byId)}catch{}
    // An unverifiable old tree stays intact as one coarse historical block.
    // It certifies only its own archived checkpoint, never unseen originals.
    if(!blocks?.length){
      const row=byId.get(entry.id)
      blocks=[{archiveId:'pi-snapshot-'+forkHash([session,entry.id,entry.summary]).slice(0,24),frozenSummary:entry.summary,frozenLevel:0,kind:'snapshot',sourceRecords:[row.ordinal]}]
    }
    const covered=new Set()
    for(const block of blocks)for(const seq of block.sourceRecords){
      if(covered.has(seq))throw Error('Pi 旧摘要分块来源重叠')
      covered.add(seq)
    }
    checkpoints.push({entryId:entry.id,summaryDigest:forkHash(entry.summary),blocks})
  }
  return checkpoints
}

export function savePiForkTree(store,session,input,fork,checkpoints,valid){
  const rows=store.eventRows(session),byOrdinal=new Map(rows.map(r=>[r.ordinal,r])),byId=new Map(rows.map(r=>[JSON.parse(store.exact(session,r.ordinal)).id,r]))
  const used=new Set(),ranges=fork.blocks.map(block=>{
    let sourceRecords
    if(block.frozenEntryId){
      const expected=checkpoints.find(c=>c.entryId===block.frozenEntryId)?.blocks.find(b=>b.archiveId===block.archiveId)
      if(!expected||['frozenSummary','frozenLevel','kind'].some(k=>block[k]!==expected[k])||block.summary!==expected.frozenSummary||!isDeepStrictEqual(block.sourceRecords,expected.sourceRecords))throw Error('Pi 旧摘要分块已变化，原文保留')
      sourceRecords=expected.sourceRecords
    }else{
      if(block.frozenSummary!==undefined||block.archiveId)throw Error('Pi 新分块不能声明旧摘要身份')
      if(!Array.isArray(block.entryIds)||!block.entryIds.length)throw Error('Pi 新分块缺少原文编号')
      sourceRecords=block.entryIds.map(id=>{const row=byId.get(id);if(!row||!input.sourceEntryIds.includes(id))throw Error('Pi 分块原文编号已失效');return row.ordinal})
    }
    return sorted(sourceRecords)
  })
  const checkpointIds=new Set(checkpoints.map(c=>c.entryId))
  const expectedRaw=[...new Set(input.sourceEntryIds.filter(id=>!checkpointIds.has(id)))]
  const actualRaw=fork.blocks.filter(b=>!b.frozenEntryId).flatMap(b=>b.entryIds)
  if(!isDeepStrictEqual(actualRaw,expectedRaw))throw Error('Pi 新分块原文覆盖不完整，原文保留')
  // Every selected checkpoint must contribute its entire verified frontier.
  for(const checkpoint of checkpoints){
    const actual=fork.blocks.filter(b=>b.frozenEntryId===checkpoint.entryId).map(b=>b.archiveId)
    if(!isDeepStrictEqual(actual,checkpoint.blocks.map(b=>b.archiveId)))throw Error('Pi 旧摘要分块覆盖不完整')
  }
  for(const range of ranges)for(const seq of range){if(used.has(seq))throw Error('Pi 摘要原文范围重复');used.add(seq)}
  const coverage=[]
  const tree=fork.tree.map(node=>{
    const sourceRecords=node.children.length?sorted(node.children.flatMap(i=>coverage[i])):ranges[node.index]
    if(!sourceRecords?.length)throw Error('Pi 摘要树缺少完整来源')
    coverage.push(sourceRecords)
    return {...node,sourceRecords,firstMessage:sourceRecords[0],lastMessage:sourceRecords.at(-1)}
  })
  const originals=sorted([...used]).map(ordinal=>{const row=byOrdinal.get(ordinal);if(!row)throw Error('Pi 历史原文归档缺失');return {ordinal,digest:row.digest}})
  // Identical model wording cannot alias different cuts after tuning changes.
  const digest=forkHash([fork.sourceDigest,tree.map(n=>[n.kind,n.semanticLevel,n.sourceRecords,n.children])])
  const ids=saveForkTree(store,session,{digest,originals},tree,{model:fork.model,usage:fork.usage,validate:valid})
  for(const node of fork.tree)node.archiveId=ids[node.index]
  // The existing shared visibility metadata also serves Pi. Historical
  // overviews stay searchable, while the chart displays one current overview.
  store.db.exec('CREATE TABLE IF NOT EXISTS dsh_shared_nodes(session TEXT NOT NULL,id TEXT NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(session,id))')
  store.db.exec('BEGIN IMMEDIATE')
  try{
    if(!valid())throw Error('Pi 摘要设置已变化')
    const snapshots=new Set(store.db.prepare('SELECT id FROM dsh_shared_nodes WHERE session=? AND visible=5').all(session).map(r=>r.id))
    store.db.prepare('INSERT OR IGNORE INTO dsh_shared_nodes SELECT session,id,4 FROM nodes WHERE session=?').run(session)
    store.db.prepare('UPDATE dsh_shared_nodes SET visible=CASE WHEN visible=3 THEN 2 WHEN visible IN (1,5) THEN 4 ELSE visible END WHERE session=?').run(session)
    const mark=store.db.prepare('UPDATE dsh_shared_nodes SET visible=? WHERE session=? AND id=?'),visited=new Set()
    const activate=id=>{
      if(visited.has(id))return;visited.add(id)
      const node=store.node(session,id);if(!node)throw Error('Pi 摘要祖先缺失')
      const declared=tree.find(n=>ids[n.index]===id)
      mark.run(declared?.kind==='snapshot'||snapshots.has(id)?5:1,session,id)
      for(const child of JSON.parse(node.children))activate(child)
    }
    for(const id of ids)activate(id)
    const root=fork.tree.at(-1)
    if(root.kind==='overview')mark.run(3,session,ids.at(-1))
    store.db.exec('COMMIT')
    return {summaryRootId:ids.at(-1),summaryRootKind:root.kind,summaryTreeFormat:'pi-incremental-v1'}
  }catch(error){store.db.exec('ROLLBACK');throw error}
}
