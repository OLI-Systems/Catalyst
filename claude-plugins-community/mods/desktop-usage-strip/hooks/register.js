import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-usage-strip", TITLE="Desktop Usage Strip"
let surface=null,prefix=''
let records=[],enabled=true
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Show quota, reset countdowns, tokens, and cost in a composer strip.",immediate:true})
  if(surface==='desktop'){$.clock.every(60000,()=>$.ui.invalidate('ui.render'))}
  return next(e)
 })
 on('command.run',{command:"desktop-usage-strip"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })

on('turn.step',async function*($,e,next){
 const r=yield* next(e)
 if(r.usage){records=[...records,{model:clean(e.model,80),...r.usage}].slice(-30);$.ui.invalidate('ui.render')}
 return r
})


on('ui.render',{component:'AbovePrompt'},async($,e,next)=>{
 const downstream=await next(e)
 if(e.surface!=='desktop'||!enabled||e.props.hasSurvey)return downstream
 const E=$.ui.resolve(e),u=await $.session.usage(),now=await $.clock.now()
 const parts=usageChips(u,records,now)
 return E.Box({flexDirection:'column',gap:1,children:[strip(E,parts,e.props.bodyColumns),...(downstream?[downstream]:[])]})
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
const chips=usageChips(u,records,now)
return [strip(E,chips,e.props.bodyColumns),text(E,'Token totals: latest '+records.length+' observed requests. USD is the engine session ledger, not a subscription charge.'),button('toggle',enabled?'Hide composer strip':'Show composer strip',()=>{enabled=!enabled;redraw()})]

}
