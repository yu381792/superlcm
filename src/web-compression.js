// A dedicated destination, with independent controls and deep links per tool.
function compressionSection(tool,updateHash=true) {
  tool=tool==='dsh'?'dsh':'claude-code';state.compressionTool=tool
  for(const button of document.querySelectorAll('[data-compression-tool]')) {
    const selected=button.dataset.compressionTool===tool
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1
  }
  for(const panel of document.querySelectorAll('[data-compression]'))panel.hidden=panel.dataset.compression!==tool
  if(updateHash)history.replaceState(null,'','#compression/'+tool)
  if(tool==='dsh') {
    if(!dshControls.value&&!dshControls.loading)act(loadDshControls)
    else renderDshControls()
  }
}
for(const button of document.querySelectorAll('[data-compression-tool]')) {
  button.onclick=()=>compressionSection(button.dataset.compressionTool)
  button.onkeydown=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
    event.preventDefault()
    const tool=event.key==='Home'?'claude-code':event.key==='End'?'dsh':state.compressionTool==='dsh'?'claude-code':'dsh'
    compressionSection(tool);document.querySelector('[data-compression-tool="'+tool+'"]').focus()
  }
}
function renderCompressionOwner(id,enabled,pending=false) {
  const badge=$(id);if(!badge)return
  badge.className='state '+(pending?'warn':enabled?'warn':'on')
  badge.textContent=t(pending?'等待应用':enabled?'SuperLcm 接管':id==='#claudeCompressionOwner'?'Claude 原生压缩':'DSH 原生压缩')
}
