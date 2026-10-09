import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-checklist-desk", TITLE="Desktop Checklist Desk"
let surface=null,prefix=''
let items=[],message=''
async function load($){items=[];for(const key of (await $.store.keys()).filter(k=>k.startsWith(prefix+'item:')).sort().slice(-100)){const x=await $.store.get(key);if(x&&typeof x.text==='string'&&[0,1,2].includes(x.phase))items.push({...x,key})}$.ui.invalidate('ui.render')}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Move saved work items through To do, Doing, and Done columns.",immediate:true})
  if(surface==='desktop'){await load($)}
  return next(e)
 })
 on('command.run',{command:"desktop-checklist-desk"},async($,e)=>{
  if(surface!=='desktop')return {text:TITLE+' requires the Claude Desktop Code tab.'}
  await load($)
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
 return [input('entry','Work item','',async(v)=>{try{const s=bounded(v.trim(),1000);if(!s)return;const keys=(await $.store.keys()).filter(k=>k.startsWith(prefix+'item:'));if(keys.length>=100)throw Error('Limit is 100 items; delete one first.');await $.store.set(prefix+'item:'+new Date(await $.clock.now()).toISOString()+':'+crypto.randomUUID(),{text:s,phase:0});await load($)}catch(error){message=error.message;redraw()}}),columns(E,e,['To do','Doing','Done'].map((name,phase)=>[text(E,name,{bold:true}),...items.filter(x=>x.phase===phase).map(x=>frame(E,x.text,[button('move-'+x.key,'Move to '+['To do','Doing','Done'][(phase+1)%3],async()=>{const latest=await $.store.get(x.key);if(latest)await $.store.set(x.key,{...latest,phase:(latest.phase+1)%3});await load($)}),button('delete-'+x.key,'Delete',async()=>{await $.store.delete(x.key);await load($)})])),...(items.some(x=>x.phase===phase)?[]:[text(E,'Empty')])])),text(E,message||items.length+' saved items'),button('reload','Reload board',()=>load($))]
}
