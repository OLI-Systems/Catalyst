import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-tool-pulse", TITLE="Desktop Tool Pulse"
let surface=null,prefix=''
let records=[]
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart completed tool latency and failures by tool.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-tool-pulse"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })
 on('tool.call',async($,e,next)=>{const t=await $.clock.now();try{const r=await next(e);records=[...records,{tool:clean(e.tool,80),ms:Math.max(0,(await $.clock.now())-t),failed:!!(r.deny||r.isError)}].slice(-100);$.ui.invalidate('ui.render');return r}catch(error){records=[...records,{tool:clean(e.tool,80),ms:Math.max(0,(await $.clock.now())-t),failed:true}].slice(-100);$.ui.invalidate('ui.render');throw error}})

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
 const names=[...new Set(records.map(r=>r.tool))].slice(0,12),means=names.map(n=>{const a=records.filter(r=>r.tool===n);return a.reduce((s,r)=>s+r.ms,0)/a.length})
return [text(E,records.length+' observed calls · '+records.filter(r=>r.failed).length+' failures'),...(names.length?[chart(E,means,names,'Average completed tool milliseconds')]:[text(E,'No tools observed yet.')]),...names.map(n=>text(E,n+': '+records.filter(r=>r.tool===n).length+' calls')),button('clear','Clear tool chart',()=>{records=[];redraw()})]
}
