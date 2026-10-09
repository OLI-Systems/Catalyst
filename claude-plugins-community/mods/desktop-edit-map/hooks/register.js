import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-edit-map", TITLE="Desktop Edit Map"
let surface=null,prefix=''
let edits=[]
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart successful built-in edits grouped by file path.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-edit-map"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })
 on('tool.call',{tool:['Edit','Write']},async($,e,next)=>{const r=await next(e);if(!r.deny&&!r.isError){edits=[...edits,clean(e.file_path,500)].slice(-100);$.ui.invalidate('ui.render')}return r})

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
 const names=[...new Set(edits)].slice(0,12)
return [text(E,edits.length+' successful Edit/Write calls observed'),...(names.length?[chart(E,names.map(n=>edits.filter(p=>p===n).length),names.map(n=>n.split('/').pop()),'Edits per file'),...names.map(n=>text(E,n))]:[text(E,'No edits observed.')]),text(E,'Bash, MCP, and other mods’ writes are not detected.'),button('clear','Clear edit map',()=>{edits=[];redraw()})]
}
