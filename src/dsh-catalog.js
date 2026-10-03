// Read DSH's configured native adapters and their installed catalogs. No
// model prompt, credential resolution, endpoint discovery or settings write.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { existsSync,readFileSync,readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHost,dshHome,dshEntries } from './dsh-connection.js'
import { runCommand as run,commandOptions } from './runtime.js'
import { readControls } from '../dsh/controls-config.js'
export const adapterNames = new Set(['@deepseek-ai/dsh-llm-pi-ai','@deepseek-ai/dsh-llm-deepseek-api-key','@deepseek-ai/dsh-llm-deepseek-account'])
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex')
export async function dshConfiguration({env=process.env,runCommand=run,host=dshHost(env)}={}) {
  const dir=join(dshHome(env),'profiles'),profiles=[]
  let names=[];try{names=readdirSync(dir).filter(n=>/^[\w-][\w.-]{0,80}$/.test(n)&&n!=='node_modules'&&existsSync(join(dir,n,'package.json')))}catch{}
  await Promise.all(names.map(async name=>{
    const manifest=readFileSync(join(dir,name,'package.json'),'utf8'),patch=existsSync(join(dir,name,'cordis.patch.yml'))?readFileSync(join(dir,name,'cordis.patch.yml'),'utf8'):null
    const result=await runCommand(host.bin,[...host.argsPrefix,'--profile',name,'--dump-config'],{...commandOptions(env),timeout:5000})
    profiles.push({name,dir:join(dir,name),manifest,patch,tree:host.parse(result.stdout)})
  }))
  profiles.sort((a,b)=>a.name.localeCompare(b.name))
  return {host,profiles}
}
function variant(plugin,id,config) {
  const identity={...config};delete identity.models;delete identity.modelOverrides
  return hash({plugin,id,config:identity}).slice(0,24)
}
export async function readDshCatalog(configuration) {
  const {host,profiles}=configuration,load=name=>import(pathToFileURL(host.require.resolve(name)).href)
  const {Context}=await load('@deepseek-ai/cordis'),{default:Llm}=await load('@deepseek-ai/dsh-llm')
  const choices=new Map(),errors=[]
  for(const profile of profiles) {
    const rows=dshEntries(profile.tree),entries=rows.filter(e=>adapterNames.has(e.name))
    for(const row of rows){for(const spec of [row.config?.summaryAdapter,readControls(row.config?.controlFile)?.config.summaryAdapter])if(spec&&adapterNames.has(spec.plugin))entries.push({name:spec.plugin,config:spec.config})}
    for(const entry of entries) {
      const ctx=new Context()
      try {
        new Llm(ctx)
        const plugin=await load(entry.name)
        let normalized
        try {normalized=plugin.Config(entry.config||{});plugin.apply(ctx,normalized)}catch{errors.push({source:entry.name,error:'模型配置无法读取'});continue}
        // Registered providers, not every dormant provider the SDK could offer.
        const active=ctx.llm.listProviders()
        const owned=entry.name.endsWith('dsh-llm-pi-ai')?Object.keys(entry.config?.providers||{}):[entry.name.endsWith('api-key')?'deepseek-official':'deepseek-account']
        const configured=ctx.llm.listConfigurableProviders().filter(p=>owned.includes(p.provider)).map(p=>({id:p.provider,name:p.displayName,error:p.error}))
        for(const provider of configured) {
          let models=[];if(active.some(p=>p.id===provider.id))try{models=await ctx.llm.listModels(provider.id)}catch{errors.push({provider:provider.id,error:'模型目录无法读取'})}
          if(provider.error)errors.push({provider:provider.id,error:'部分模型配置无法读取'})
          if(entry.name.endsWith('deepseek-account')&&!models.length){const common=await load('@deepseek-ai/dsh-llm-deepseek');models=common.plainOptions(normalized).models.map(m=>common.catalogModelInfo(provider.id,m))}
          const definition=entry.name.endsWith('dsh-llm-pi-ai')?entry.config.providers[provider.id]:(entry.config||{})
          const ref=variant(entry.name,provider.id,definition)
          if(!choices.has(ref)) choices.set(ref,{ref,id:provider.id,label:provider.name||provider.id,models:[],_plugin:entry.name,_config:definition,_sources:[]})
          const choice=choices.get(ref);choice._sources.push(profile.name)
          for(const model of models) if(!choice.models.some(m=>m.id===model.id)) choice.models.push({id:model.id,label:model.name||model.id})
          if(entry.name.endsWith('dsh-llm-pi-ai')) {
            const existing=choice._config.models||[],incoming=definition.models||[]
            choice._config={...choice._config,models:[...existing,...incoming.filter(m=>!existing.some(x=>x.id===m.id))]}
            if(!existing.length&&!incoming.length)delete choice._config.models
            if(definition.modelOverrides)choice._config.modelOverrides={...definition.modelOverrides,...choice._config.modelOverrides}
          }
        }
      } finally {await ctx.fiber.dispose()}
    }
  }
  const providers=[...choices.values()]
  for(const choice of providers) {
    const others=providers.filter(p=>p.id===choice.id)
    if(others.length>1)choice.label+=' · 配置 '+(others.indexOf(choice)+1)
  }
  return {providers,errors,source:'DSH configured adapters and installed native model catalogs'}
}
export function publicCatalog(catalog) {
  return {...catalog,providers:catalog.providers.map(({_plugin,_config,_sources,...provider})=>provider)}
}
