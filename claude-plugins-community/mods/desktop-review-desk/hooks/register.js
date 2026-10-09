import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-review-desk", TITLE="Desktop Review Desk"
let surface=null,prefix=''
let tab='status',report='Open to inspect Git.'

async function load($){try{const args=tab==='status'?['status','--short','--branch']:tab==='staged'?['diff','--cached','--no-ext-diff','--no-textconv','--no-color','--']:['diff','--no-ext-diff','--no-textconv','--no-color','--']
 const r=await $.process.run(['git','--no-pager',...args],{cwd:await $.session.cwd(),timeoutMs:10000});report=clean(r.exitCode===0?r.stdout||'No changes.':'Git inspection failed: '+r.stderr)}catch(error){report='Git inspection failed: '+error.message}$.ui.invalidate('ui.render')}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Switch between Git status, staged diff, and unstaged diff.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-review-desk"},async($,e)=>{
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
 return [row(E,['status','staged','unstaged'].map(t=>button('tab-'+t,t+(tab===t?' ✓':''),async()=>{tab=t;await load($)}))),code(E,report),button('reload','Reload Git',()=>load($)),button('copy','Copy visible report',()=>copy(report)),text(E,'Read-only Git inspection. No staging, commits, or command execution from the diff.') ]
}
