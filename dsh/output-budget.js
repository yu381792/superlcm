import {outputBudget} from './ratio-policy.js'
import {abortable} from './summary-attempt.js'

// Keep the configured ceiling separate from the effective, normally logged
// request header. A private receipt preserves restoration across host restarts.
export function createOutputBudgetState(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS superlcm_output_budget(
    session TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,
    requested INTEGER NOT NULL,explicit INTEGER NOT NULL,effective INTEGER NOT NULL,
    option_max INTEGER,active INTEGER NOT NULL)`)
  return {
    read:id=>db.prepare('SELECT * FROM superlcm_output_budget WHERE session=?').get(id),
    release:id=>db.prepare('UPDATE superlcm_output_budget SET active=0 WHERE session=?').run(id),
    save:value=>db.prepare(`INSERT INTO superlcm_output_budget VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(session) DO UPDATE SET provider=excluded.provider,model=excluded.model,requested=excluded.requested,
      explicit=excluded.explicit,effective=excluded.effective,option_max=excluded.option_max,active=1`)
      .run(value.session,value.provider,value.model,value.requested,value.explicit,value.effective,value.option_max,1),
  }
}
export function registerOutputBudget(engine,store,{restoreOnly=false,context=engine.ctx}={}) {
  const state=store.outputBudgetState(),ctx=context,life=new AbortController()
  engine.outputBudgetState=state
  const read=state.read
  const own=(row,config)=>row?.active===1&&row.provider===config.provider&&row.model===config.model&&row.effective===config.maxTokens
  const original=(config,row)=>{
    const result={...config}
    if(row.explicit)result.maxTokens=row.requested
    else delete result.maxTokens
    return result
  }
  ctx.on('session/event',(session,event)=>{
    if(event.type!=='request/header')return
    const row=read(session.id)
    if(row?.active&&!own(row,event.data.header.config))state.release(session.id)
  })
  ctx.on('agent/request',async({agent,signal},next)=>{
    const proposed=await next(),session=agent.session
    const row=read(session.id),owned=own(row,proposed),option=agent.options?.maxTokens??null
    const config=owned&&option===row.option_max?original(proposed,row):owned&&option!==null?{...proposed,maxTokens:option}:proposed
    if(restoreOnly||!engine.config.auto||engine.rollingConfig.budgetMode!=='ratio')return config
    const abort=AbortSignal.any([signal,life.signal])
    const info=await abortable(ctx.llm.resolveModelInfo(config.provider,config.model,abort),abort)
    abort.throwIfAborted()
    const window=info.context?.contextWindow,requested=config.maxTokens??info.defaultMaxTokens
    // Admission still owns invalid/unknown-capacity rejection so the native
    // host durably retains the current input before showing the error.
    if(!Number.isSafeInteger(window)||!Number.isSafeInteger(requested)||requested<1||window-requested<1024)return config
    const effective=outputBudget(window,engine.rollingConfig.switchRatio,requested)
    if(effective===requested)return config
    const value={session:session.id,provider:config.provider,model:config.model,requested,explicit:+(config.maxTokens!==undefined),effective,option_max:option,active:1}
    if(!row||Object.keys(value).some(k=>row[k]!==value[k]))state.save(value)
    return {...config,maxTokens:effective}
  })
  ctx.effect(()=>()=>{
    life.abort(Error('输出容量保护已关闭'))
    if (engine.outputBudgetState===state) delete engine.outputBudgetState
    // Restoring belongs to the next native request, inside its open turn.
    // Teardown may already be after turn/end and must never append headers.
  })
}
