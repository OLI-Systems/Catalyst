import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-token-flow", TITLE="Desktop Token Flow"
let surface=null,prefix=''
let records=[]
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart uncached input, output, cache reads, and cache writes.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-token-flow"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })

on('turn.step',async function*($,e,next){
 const r=yield* next(e)
 if(r.usage){records=[...records,{model:clean(e.model,80),...r.usage}].slice(-30);$.ui.invalidate('ui.render')}
 return r
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
 const total=records.reduce((a,r)=>a.map((n,i)=>n+num(r[['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'][i]])),[0,0,0,0])
return [text(E,'Latest '+records.length+' observed requests; API-reported token categories.'),...(records.length?[chart(E,total,['Uncached input','Output','Cache read','Cache write'],'Token totals: '+total.join(', '))]:[text(E,'No requests observed yet.')]),button('clear','Clear observations',()=>{records=[];redraw()})]
}
