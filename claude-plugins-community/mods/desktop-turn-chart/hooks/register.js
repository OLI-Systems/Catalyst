import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-turn-chart", TITLE="Desktop Turn Chart"
let surface=null,prefix=''
let turns=[]
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart turn durations with interruption labels.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-turn-chart"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })
 on('turn.complete',async($,e,next)=>{turns=[...turns,{ms:num(e.durationMs),aborted:e.isAborted,agent:clean(e.agentId||'main',60)}].slice(-12);$.ui.invalidate('ui.render');return next(e)})

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
 return [text(E,turns.length+' completed turns observed'),...(turns.length?[chart(E,turns.map(t=>t.ms/1000),turns.map((t,i)=>'#'+(i+1)+(t.aborted?' interrupted':'')),'Turn duration in seconds'),...turns.map((t,i)=>text(E,'#'+(i+1)+' '+t.agent+' · '+(t.ms/1000).toFixed(1)+'s'+(t.aborted?' · interrupted':'')))]:[text(E,'No completed turns observed.')]),button('clear','Clear turn chart',()=>{turns=[];redraw()})]
}
