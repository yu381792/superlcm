// Archive and native compaction share one branch producer per live DSH session.
import {ArchiveDatabase} from './archive-db.js'
import {registerArchiveCapture,summarizeArchiveFork,registerForkArchive} from './archive-fork.js'
import {readSettings} from './settings.js'
import {ClaudeStore} from '../src/store.js'
import {saveForkTree} from '../src/main-fork.js'
import {dshSessionKey} from '../src/dsh.js'
import {forkHash} from './fork-summary.js'
import {markerFromSummary} from './marker.js'
import {isDeepStrictEqual} from 'node:util'
import {semanticLevel,semanticKind,originalNodeSources} from './tree-semantics.js'
import {waitForRetry,failureKind} from './fork-retry.js'
export class MainArchiveFork {
  constructor(ctx,native,home,warn,{report=()=>{}}={}){
    this.ctx=ctx;this.native=native;this.file=home;this.warn=warn;this.report=report;this.db=new ArchiveDatabase(native.path);this.store=new ClaudeStore(home);this.jobs=new Map();this.mirrored=new Map();this.stopped=false
    this.onTreeSaved=id=>this.mirror(id);registerArchiveCapture(this)
    this.unregister=registerForkArchive(native.path,async(id,tree,receipt)=>{
      const doc=readSettings(home);if(this.stopped||!doc.settings.summaryEnabled)return
      this.capture(id)
      const owner=this.db.lease(id,doc.revision);if(!owner)return
      try{
        const rows=this.db.sourceRows(id),known=new Set(rows.map(r=>r.seq))
        const expand=(seq,active=new Set())=>{
          if(known.has(seq))return [seq]
          if(active.has(seq))throw Error('DSH 摘要原文引用成环');active.add(seq)
          const event=ctx.sessions.get(id)?.eventAt(seq),marker=markerFromSummary(event?.data?.content),node=marker&&native.getNode(id,marker.id)
          if(!node)throw Error('DSH 摘要原文引用缺失')
          const sources=node.sourceSeqs.flatMap(s=>expand(s,active));active.delete(seq);return sources
        }
        const all=new Map(tree.map(n=>[n.id,n]))
        const include=(key,seen=new Set())=>{
          if(seen.has(key))throw Error('DSH 摘要祖先成环')
          let node=all.get(key)
          if(!node){
            if(!key.startsWith('native:'))throw Error('DSH 摘要祖先缺失')
            const nativeId=key.slice(7),old=native.getNode(id,nativeId)
            if(!old)throw Error('DSH 摘要祖先缺失')
            node={id:key,nativeId,kind:semanticKind(native,id,nativeId),level:semanticLevel(native,id,nativeId)-1,summary:old.summaryText,sources:originalNodeSources(native,id,nativeId,seq=>ctx.sessions.get(id)?.eventAt(seq)),children:old.childIds.map(child=>'native:'+child)}
            all.set(key,node)
          }
          const next=new Set([...seen,key]);for(const child of node.children)include(child,next)
        }
        for(const n of tree)include(n.id)
        const nodes=[...all.values()].map(n=>({...n,sources:[...new Set(n.sources.flatMap(seq=>expand(seq)))]}))
        this.db.saveTree(id,nodes,owner,doc.revision,()=>readSettings(home).revision,rows,receipt)
        this.mirror(id)
      }finally{this.db.release(id,owner)}
    },()=>readSettings(home).revision)
  }
  capture(id){const session=this.ctx.sessions.get(id);if(session){const cursor=this.db.cursor(id);this.db.capture(session.header,Array.from({length:Math.max(0,session.seq-cursor)},(_,i)=>session.eventAt(cursor+i)))}}
  mirror(id){
    const session=dshSessionKey(id),nodes=this.db.nodes(id),stamp=forkHash(nodes.map(n=>n.id));if(!nodes.length||!this.store.source(session)||this.store.isDeleted(session))return
    const archiveId=node=>node.nativeId?'dsh-native-'+node.nativeId:'dsh-fork-'+forkHash([id,node.id]).slice(0,24)
    if(this.mirrored.get(id)===stamp){
      // An explicit re-import can recreate the same native tree after deleting
      // its shared copy. The in-memory stamp alone cannot prove it is present.
      const known=new Set(this.store.db.prepare('SELECT id FROM nodes WHERE session=?').all(session).map(row=>row.id))
      if(nodes.every(node=>known.has(archiveId(node))))return
    }
    const rows=this.db.sourceRows(id),originals=[],positions=new Map()
    for(const row of this.store.db.prepare('SELECT ordinal,digest FROM events WHERE session=? ORDER BY ordinal').all(session)){
      const record=JSON.parse(this.store.exact(session,row.ordinal));if(record.event?.seq!==undefined)positions.set(record.event.seq,{...row,event:record.event})
    }
    const wanted=new Set(nodes.flatMap(n=>n.sources))
    for(const seq of wanted){
      const source=rows.find(r=>r.seq===seq),record=positions.get(seq)
      if(!source||!record)return // The raw archive worker has not reached this prefix yet.
      if(!isDeepStrictEqual(JSON.parse(source.event),record.event))throw Error('DSH 分支原文与共享归档不一致')
      originals.push({ordinal:record.ordinal,digest:record.digest})
    }
    const ids=new Map(nodes.map((n,index)=>[n.id,index]))
    const tree=nodes.map((node,index)=>{
      const sourceRecords=node.sources.map(seq=>positions.get(seq).ordinal)
      const variant=this.db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sl_summary_variants'").get()?this.db.db.prepare('SELECT summary FROM sl_summary_variants WHERE session=? AND id=?').get(id,node.id)?.summary:undefined
      const native=node.nativeId&&this.native.getNode(id,node.nativeId)
      return {index,archiveId:archiveId(node),level:native?semanticLevel(this.native,id,node.nativeId)-1:node.level,kind:native?semanticKind(this.native,id,node.nativeId):node.kind,modelSummary:variant,firstMessage:Math.min(...sourceRecords),lastMessage:Math.max(...sourceRecords),sourceRecords,children:node.children.map(child=>{if(!ids.has(child))throw Error('DSH 分支摘要树不完整');return ids.get(child)}),summary:node.summary}
    })
    const doc=readSettings(this.file)
    if(!doc.settings.summaryEnabled)return
    const receipt=this.db.db.prepare("SELECT 1 FROM sqlite_master WHERE name='sl_fork_receipts'").get()&&this.db.db.prepare('SELECT * FROM sl_fork_receipts WHERE session=?').get(id)
    saveForkTree(this.store,session,{digest:forkHash(nodes.map(n=>n.id)),originals},tree,{model:receipt?.model||'dsh:session-model',usage:receipt?JSON.parse(receipt.usage):{},validate:()=>!this.stopped&&readSettings(this.file).revision===doc.revision})
    this.store.db.exec('CREATE TABLE IF NOT EXISTS dsh_shared_nodes(session TEXT NOT NULL,id TEXT NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(session,id))')
    const currentOverviewIds=new Set(),coveredOverviews=[]
    for(const node of tree.filter(n=>n.kind==='overview').sort((a,b)=>b.index-a.index)){
      if(!coveredOverviews.some(current=>node.sourceRecords.every(seq=>current.has(seq)))){currentOverviewIds.add(node.archiveId);coveredOverviews.push(new Set(node.sourceRecords))}
    }
    const historical=new Set(),retire=index=>{if(historical.has(index))return;historical.add(index);for(const child of tree[index].children)retire(child)}
    for(const node of tree)if(node.kind==='snapshot')for(const child of node.children)retire(child)
    for(const node of tree){
      this.store.db.prepare('UPDATE nodes SET level=? WHERE session=? AND id=?').run(node.level,session,node.archiveId)
      const visible=node.kind==='assembled'?0:historical.has(node.index)?4:node.kind==='overview'?(currentOverviewIds.has(node.archiveId)?3:2):node.kind==='snapshot'?5:1
      this.store.db.prepare('INSERT INTO dsh_shared_nodes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM sources WHERE session=?) AND NOT EXISTS(SELECT 1 FROM deleted_sessions WHERE session=?) ON CONFLICT(session,id) DO UPDATE SET visible=excluded.visible').run(session,node.archiveId,visible,session,session)
    }
    this.mirrored.set(id,stamp)
  }
  afterCapture(id,settled=false){
    if(this.stopped)return
    this.capture(id);this.mirror(id)
    const doc=readSettings(this.file)
    if(!settled||!doc.settings.summaryEnabled||doc.settings.takeover||this.jobs.has(id))return
    const controller=new AbortController()
    const state={controller,promise:null,owner:null,attempt:0,failures:0,lastErrorKind:null,retryAt:null};this.jobs.set(id,state)
    const valid=()=>{const current=readSettings(this.file);return !this.stopped&&!this.store.isDeleted(dshSessionKey(id))&&current.revision===doc.revision&&current.settings.summaryEnabled&&!current.settings.takeover}
    const timer=setInterval(()=>{try{if(!valid()||state.owner&&!this.db.renew(id,state.owner))controller.abort(Error('DSH 摘要任务已取消'))}catch(error){controller.abort(error)}},10000);timer.unref()
    state.promise=(async()=>{
      for(;;){
        controller.signal.throwIfAborted()
        if(!valid())return
        const owner=this.db.lease(id,doc.revision)
        if(!owner){await waitForRetry(1000,controller.signal);continue}
        state.owner=owner;state.attempt++;state.retryAt=null
        this.report(id,'summarizing',{attempt:state.attempt,failures:state.failures})
        let error
        try{
          const result=await summarizeArchiveFork(this,id,doc,owner,controller.signal)
          if(result==='complete')this.report(id,'ready',{attempt:state.attempt,failures:state.failures})
          return
        }catch(e){error=e}
        finally{this.db.release(id,owner);state.owner=null}
        controller.signal.throwIfAborted()
        if(!valid())return
        state.failures++;state.lastErrorKind=failureKind(error)
        const delay=Math.min(300000,1000*2**Math.min(9,state.failures-1));state.retryAt=Date.now()+delay
        this.report(id,'retrying',{attempt:state.attempt,failures:state.failures,retryAt:state.retryAt,errorKind:state.lastErrorKind})
        this.warn(Error(`DSH 后台摘要第 ${state.attempt} 次未完成（${state.lastErrorKind}），将自动重试`))
        await waitForRetry(delay,controller.signal)
      }
    })().catch(error=>{if(!controller.signal.aborted)this.warn(error)}).finally(()=>{clearInterval(timer);if(this.jobs.get(id)===state)this.jobs.delete(id)})
  }
  async close(){this.stopped=true;this.unregister();for(const job of this.jobs.values())job.controller.abort(Error('DSH 归档已停止'));await Promise.allSettled([...this.jobs.values()].map(j=>j.promise));this.db.close();this.store.close()}
}
