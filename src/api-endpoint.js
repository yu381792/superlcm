// A local gateway on this computer (plain HTTP on numeric loopback) may need no key at all.
// 思考程度 values a custom API model may set (OpenAI reasoning_effort names).
export const EFFORTS=['minimal','low','medium','high','xhigh']
// API model IDs go only into a JSON body, never a command line: any visible text without spaces.
export const validApiModel=id=>typeof id==='string'&&/^[^\s\u0000-\u001f\u007f]{1,200}$/.test(id)
const LOOPBACK=['127.0.0.1','[::1]','localhost']
export function loopbackEndpoint(address){try{const url=new URL(address);return url.protocol==='http:'&&LOOPBACK.includes(url.hostname)}catch{return false}}
export function normalizeApiEndpoint(provider,address) {
  if(!['anthropic','openai'].includes(provider))throw new Error('API protocol must be Anthropic Messages or OpenAI Chat Completions')
  if(typeof address!=='string'||!address.trim()||address.length>2048)throw new Error('Enter an API HTTPS endpoint URL')
  let url
  try{url=new URL(address)}catch{throw new Error('Invalid API endpoint URL')}
  const local=url.protocol==='http:'&&LOOPBACK.includes(url.hostname)
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash)throw new Error('API endpoint must be HTTPS (HTTP allowed only on numeric loopback), without URL credentials/query/fragment')
  // A base URL is completed the way the official SDKs do: OpenAI appends /chat/completions to a base that
  // already names its version (…/v1, …/v1beta/openai), Anthropic appends /v1/messages (or /messages after /v1).
  const path=url.pathname.replace(/\/+$/,'')
  if(provider==='openai'&&!path.endsWith('/chat/completions'))url.pathname=(path||'/v1')+'/chat/completions'
  if(provider==='anthropic'&&!path.endsWith('/messages'))url.pathname=path+(path.endsWith('/v1')?'/messages':'/v1/messages')
  return url.toString()
}
