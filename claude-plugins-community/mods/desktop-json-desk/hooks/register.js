import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-json-desk", TITLE="Desktop JSON Desk"
let surface=null,prefix=''
let source='',parsed=null,filter='',message='Paste JSON to begin.'
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Validate pasted JSON with a searchable key summary and formatted preview.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-json-desk"},async($,e)=>{
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
 const list=parsed&&typeof parsed==='object'?Object.entries(parsed).filter(([k])=>k.toLowerCase().includes(filter.toLowerCase())).slice(0,50):[]
const formatted=JSON.stringify(parsed,null,2)
return [input('source','JSON',source,v=>{try{source=bounded(v,9000);parsed=JSON.parse(source);message='Valid JSON.'}catch(error){parsed=null;message='Invalid JSON: '+error.message}redraw()}),input('filter','Filter top-level keys',filter,v=>{filter=bounded(v,200);redraw()}),text(E,message),columns(E,e,[[text(E,'Keys (up to 50)',{bold:true}),...list.map(([k,v])=>text(E,k+' · '+(v===null?'null':Array.isArray(v)?'array':typeof v)))],[text(E,'Formatted preview',{bold:true}),code(E,message==='Valid JSON.'?formatted:'No valid JSON.')]]),button('copy','Copy formatted JSON',async()=>{if(message==='Valid JSON.')await copy(bounded(formatted,30000))})]
}
