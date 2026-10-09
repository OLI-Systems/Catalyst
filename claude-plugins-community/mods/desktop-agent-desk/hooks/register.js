import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-agent-desk", TITLE="Desktop Agent Desk"
let surface=null,prefix=''
let filter=''
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Filter reported agents and copy a status snapshot.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-agent-desk"},async($,e)=>{
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
 const all=await $.agent.list(),agents=all.filter(a=>(a.description+' '+a.status+' '+a.id).toLowerCase().includes(filter.toLowerCase())).slice(0,30)
const snapshot=agents.map(a=>a.id+' · '+a.status+' · '+a.description).join('\n')
return [input('filter','Filter agents',filter,v=>{filter=bounded(v,200);redraw()}),text(E,agents.length+' matching agents'),...agents.map(a=>frame(E,clean(a.description,200),[text(E,a.id+' · '+a.status+' · '+(a.type||'unspecified'))])),...(agents.length?[]:[text(E,'No matching agents reported.')]),button('copy','Copy roster',()=>copy(snapshot))]
}
