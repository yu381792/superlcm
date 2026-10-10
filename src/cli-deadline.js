// One owned summary subprocess. Failure settles the caller immediately;
// a child ignoring SIGTERM is killed after a short grace period.
export function cliDeadline(child, timeoutMs, fail, name) {
  let hardKill, stopping=false
  const stop=message=>{
    if(stopping)return
    stopping=true;clearTimeout(timer)
    hardKill=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},250)
    try{child.kill('SIGTERM')}catch{}
    fail(new Error(message))
  }
  const timer=setTimeout(()=>stop(`${name} summarization timed out`),timeoutMs)
  child.once('close',()=>{clearTimeout(timer);clearTimeout(hardKill)})
  return {stop,clear:()=>clearTimeout(timer)}
}
