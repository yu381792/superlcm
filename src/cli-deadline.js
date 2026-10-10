// One owned summary subprocess. Failure settles the caller immediately;
// a child ignoring SIGTERM is killed after a short grace period.
export function cliDeadline(child, timeoutMs, fail, name, signal) {
  let hardKill, stopping=false
  const stop=message=>{
    if(stopping)return
    stopping=true;clearTimeout(timer)
    hardKill=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},250)
    try{child.kill('SIGTERM')}catch{}
    fail(message instanceof Error?message:new Error(message))
  }
  const timer=setTimeout(()=>stop(`${name} summarization timed out`),timeoutMs)
  const aborted=()=>stop(signal.reason||new Error('Summary generation cancelled'))
  signal?.addEventListener('abort',aborted,{once:true})
  if(signal?.aborted)queueMicrotask(aborted)
  child.once('close',()=>{clearTimeout(timer);clearTimeout(hardKill);signal?.removeEventListener('abort',aborted)})
  return {stop,clear:()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted)}}
}
