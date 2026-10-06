// DSH provides the branded card; all settings have one console owner.
window.__ModuleLoader__.load({id:'superlcm',factory:require=>{
  const R=require('react'),h=R.createElement
  function Form({connection}) {
    const [url,setUrl]=R.useState(''),[error,setError]=R.useState('')
    const read=async()=>{
      try {
        const result=await connection.rpc.call('/api','superlcm/read',null)
        if(!result.ok)throw Error(result.error.message)
        const location=result.value.console
        const target=new URL(location.url||window.location.href)
        if(!location.url){target.port=String(location.port);target.pathname='/'}
        if(!['http:','https:'].includes(target.protocol))throw Error('后台地址无效')
        target.username='';target.password='';target.search='';target.hash='compression/dsh'
        setUrl(target.href);setError('')
      }catch(e){setError(e.message)}
    }
    R.useEffect(()=>{read()},[])
    return h('div',{'data-superlcm-settings':true,style:{padding:'8px 0'}},
      h('p',{style:{color:'var(--dsw-alias-label-secondary)',margin:'0 0 16px'}},'摘要和压缩设置统一在 SuperLcm 后台管理。'),
      error?h('p',{role:'alert'},error):null,
      url?h('a',{href:url,target:'_blank',rel:'noopener noreferrer',style:{display:'inline-block',background:'#C96442',color:'#fff',borderRadius:10,padding:'10px 20px',textDecoration:'none',fontWeight:600}},'后台设置'):
        h('button',{type:'button',onClick:read,disabled:!error},error?'重新读取':'正在读取后台地址…'))
  }
  function apply(ctx) {
    ctx.slots.inject('plugins.bundle.config',()=>ctx.slots.register({name:'plugins.bundle.config',key:'superlcm',inject:()=>({connection:ctx.connection})},Form))
  }
  return {inject:['slots','connection'],apply}
}})
