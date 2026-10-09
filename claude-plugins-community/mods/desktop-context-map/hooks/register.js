import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-context-map", TITLE="Desktop Context Map"
let surface=null,prefix=''
let samples=[]
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Chart context headroom and sampled window growth.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-context-map"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}

  await $.ui.open({id:ID,title:TITLE,focus:true,closeOnEscape:true})
  return {}
 })
 on('turn.complete',async($,e,next)=>{const r=await next(e),u=await $.session.usage();if(Number.isFinite(u.context?.percent))samples=[...samples,u.context.percent].slice(-12);$.ui.invalidate('ui.render');return r})

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
 const c=(await $.session.usage()).context||{}
return [text(E,count(c.tokens)+' / '+count(c.window)+' tokens'),...(Number.isFinite(c.percent)?[gauge(E,c.percent,'Context fill')]:[text(E,'Context usage not reported.')]),text(E,'Headroom: '+(Number.isFinite(c.tokens)&&Number.isFinite(c.window)?count(Math.max(0,c.window-c.tokens)):'not reported')),
 ...(samples.length?[chart(E,samples,samples.map((_,i)=>'Turn '+(i+1)),'Sampled context percentages')]:[text(E,'Complete a turn to start sampling.')]),button('clear','Clear chart',()=>{samples=[];redraw()})]
}
