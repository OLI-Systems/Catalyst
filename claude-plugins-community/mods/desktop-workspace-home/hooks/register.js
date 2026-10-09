import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-workspace-home", TITLE="Desktop Workspace Home"
let surface=null,prefix=''
let report='Reload to inspect Git.'
async function load($){try{const r=await $.process.run(['git','--no-pager','status','--short','--branch'],{cwd:await $.session.cwd(),timeoutMs:10000});report=clean(r.exitCode===0?r.stdout||'Clean workspace.':'Git inspection failed: '+r.stderr)}catch(error){report='Git inspection failed: '+error.message}$.ui.invalidate('ui.render')}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Show the current workspace, Git state, and session usage together.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-workspace-home"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}
  await load($)
  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })


 on('ui.render',{component:'Pane'},async($,e,next)=>{
  if(e.requestId!==ID)return next(e)
  const E=$.ui.resolve(e)
  if(e.surface!=='desktop')return text(E,TITLE+' requires the Claude Desktop Code tab.')
  try{return frame(E,TITLE,[...await draw($,E,e),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])}
  catch(error){return frame(E,TITLE,[text(E,'Unable to display: '+clean(error.message,500),{color:'yellow'}),E.Button({key:'refresh',label:'Retry',onPress:()=>$.ui.invalidate('ui.render')})])}
 })
}
async function draw($,E,e){
 const redraw=()=>$.ui.invalidate('ui.render')
 const button=(key,label,onPress)=>E.Button({key,label,onPress})
 const input=(key,label,value,onSubmit)=>E.Input({key,label,value,submitLabel:'apply',onSubmit})
 const copy=async(value)=>{const r=await $.ui.copy({text:clean(value,30000)});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}
 const cwd=await $.session.cwd(),u=await $.session.usage()
return [text(E,cwd,{bold:true}),columns(E,e,[[text(E,'Workspace Git state'),code(E,report)],[text(E,'Session context: '+count(u.context?.percent)+'%'),text(E,'Reported USD: '+(Number.isFinite(u.cost?.usd)?u.cost.usd.toFixed(2):'not reported')),text(E,'Plan windows: '+u.rateLimits.length)]]),button('copy','Copy workspace path',()=>copy(cwd)),button('reload','Reload Git state',()=>load($))]
}
