import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-cost-watch", TITLE="Desktop Cost Watch"
let surface=null,prefix=''
let budget=5,message=''
export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Set a local budget reminder against reported session USD.",immediate:true})
  if(surface==='desktop'){const saved=await $.store.get(prefix+'budget');if(Number.isFinite(saved)&&saved>0)budget=saved}
  return next(e)
 })
 on('command.run',{command:"desktop-cost-watch"},async($,e)=>{
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
 const usd=(await $.session.usage()).cost?.usd
return [input('budget','Session USD target',String(budget),async(v)=>{const n=Number(v);if(!Number.isFinite(n)||n<=0||n>100000){message='Use a target above 0 and at most 100000.';redraw();return}await $.store.set(prefix+'budget',n);budget=n;message='Target saved.';redraw()}),text(E,'Reported USD: '+(Number.isFinite(usd)?usd.toFixed(2):'not reported')),
 ...(Number.isFinite(usd)?[gauge(E,usd/budget*100,'Budget used'),text(E,usd>=budget?'Target reached. Reminder only.':'Remaining target: USD '+Math.max(0,budget-usd).toFixed(2))]:[]),text(E,message||'Session ledger; not an invoice or subscription charge. No calls are blocked.') ]
}
