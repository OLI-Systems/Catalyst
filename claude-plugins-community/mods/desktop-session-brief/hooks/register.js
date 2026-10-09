import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-session-brief", TITLE="Desktop Session Brief"
let surface=null,prefix=''
let calls=0,failures=0,turns=0,note=''
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Combine observed tool and turn counts with a manual handoff note.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-session-brief"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })
 on('tool.call',async($,e,next)=>{const r=await next(e);calls++;if(r.deny||r.isError)failures++;$.ui.invalidate('ui.render');return r})
on('turn.complete',async($,e,next)=>{turns++;$.ui.invalidate('ui.render');return next(e)})

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
 const summary='Workspace: '+await $.session.cwd()+'\nObserved turns: '+turns+'\nObserved tools: '+calls+'\nTool errors/refusals: '+failures+'\nUser note: '+note
return [text(E,'Counts begin at plugin load; tool completion does not prove a task passed.'),input('note','Next step / handoff',note,v=>{note=bounded(v,2000);redraw()}),code(E,summary),button('copy','Copy brief',()=>copy(summary)),button('clear','Clear counters and note',()=>{calls=0;failures=0;turns=0;note='';redraw()})]
}
