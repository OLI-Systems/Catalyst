import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-break-bell", TITLE="Desktop Break Bell"
let surface=null,prefix=''
let minutes=25,remaining=1500,running=false,last=0,message=''
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Set an adjustable countdown with a visual progress chart and toast.",immediate:true})
  if(surface==='desktop'){$.clock.every(1000,async()=>{if(!running)return;const now=await $.clock.now();remaining=Math.max(0,remaining-(now-last)/1000);last=now;if(remaining===0){running=false;$.ui.toast('Break Bell: time for a break.')}$.ui.invalidate('ui.render')})}
  return next(e)
 })
 on('command.run',{command:"desktop-break-bell"},async($,e)=>{
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
 const seconds=Math.ceil(remaining)
return [input('minutes','Minutes (1–180)',String(minutes),v=>{const n=Number(v);if(!Number.isInteger(n)||n<1||n>180){message='Use whole minutes from 1 to 180.';redraw();return}minutes=n;remaining=n*60;running=false;message='Timer reset.';redraw()}),text(E,Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0'),{bold:true}),gauge(E,(1-remaining/(minutes*60))*100,'Interval elapsed'),row(E,[button('start',running?'Pause':'Start',async()=>{const now=await $.clock.now();if(running)remaining=Math.max(0,remaining-(now-last)/1000);last=now;running=!running;redraw()}),button('reset','Reset',()=>{running=false;remaining=minutes*60;redraw()})]),text(E,message||'Local session timer. No OS alarm or background reminder after closing Claude.') ]
}
