export function normalizeApiEndpoint(provider,address) {
  if(!['anthropic','openai'].includes(provider))throw new Error('API protocol must be Anthropic Messages or OpenAI Chat Completions')
  if(typeof address!=='string'||!address.trim()||address.length>2048)throw new Error('Enter an API HTTPS endpoint URL')
  let url
  try{url=new URL(address)}catch{throw new Error('Invalid API endpoint URL')}
  const local=url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash)throw new Error('API endpoint must be HTTPS (HTTP allowed only on numeric loopback), without URL credentials/query/fragment')
  const route=provider==='anthropic'?'/v1/messages':'/v1/chat/completions'
  if(url.pathname==='/'||url.pathname==='/v1'||url.pathname==='/v1/')url.pathname=route
  return url.toString()
}
