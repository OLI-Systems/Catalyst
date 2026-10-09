import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-prompt-builder", TITLE="Desktop Prompt Builder"
let surface=null,prefix=''
let fields={goal:'',constraints:'',acceptance:''},message=''
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Build a saved prompt from goal, constraints, and acceptance criteria.",immediate:true})
  if(surface==='desktop'){const s=await $.store.get(prefix+'fields');if(s&&['goal','constraints','acceptance'].every(k=>typeof s[k]==='string'&&s[k].length<=2000))fields=s}
  return next(e)
 })
 on('command.run',{command:"desktop-prompt-builder"},async($,e)=>{
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
 const draft=['Goal: '+fields.goal,'Constraints: '+fields.constraints,'Acceptance criteria: '+fields.acceptance].join('\n\n')
return [...Object.entries(fields).map(([key,v])=>input(key,key,v,async(value)=>{try{const next={...fields,[key]:bounded(value.trim(),2000)};await $.store.set(prefix+'fields',next);fields=next;message='Saved locally.'}catch(error){message=error.message}redraw()})),code(E,draft),button('draft','Fill composer draft',async()=>{if(!fields.goal){message='Enter a goal first.';redraw();return}const r=await $.prompt.fill({text:draft});if(!r.isFilled)$.ui.toast('Composer unavailable.')}),button('copy','Copy prompt',()=>copy(draft)),text(E,message||'Fill replaces the current composer draft; review and send it yourself.') ]
}
