import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-quota-clock", TITLE="Desktop Quota Clock"
let surface=null,prefix=''

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart reported plan windows with live reset countdowns.",immediate:true})
  if(surface==='desktop'){$.clock.every(60000,()=>$.ui.invalidate('ui.render'))}
  return next(e)
 })
 on('command.run',{command:"desktop-quota-clock"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

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
 const u=await $.session.usage(),now=await $.clock.now()
return [...u.rateLimits.slice(0,8).flatMap(r=>[text(E,r.kind+' · '+count(r.percentUsed)+'% · '+waitUntil(r.resetsAt,now)),...(Number.isFinite(r.percentUsed)?[gauge(E,r.percentUsed,r.kind)]:[])]),...(u.rateLimits.length?[]:[text(E,'No plan windows reported.')])]
}
