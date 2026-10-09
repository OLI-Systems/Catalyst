import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-bookmark-dock", TITLE="Desktop Bookmark Dock"
let surface=null,prefix=''
let items=[],label='',url='',message=''
async function load($){items=[];for(const key of (await $.store.keys()).filter(k=>k.startsWith(prefix+'item:')).sort().slice(-100)){const x=await $.store.get(key);if(x&&typeof x.label==='string'&&typeof x.url==='string'){try{const u=new URL(x.url);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)items.push({...x,key})}catch{}}}$.ui.invalidate('ui.render')}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Keep labeled web references with copy and delete controls.",immediate:true})
  if(surface==='desktop'){await load($)}
  return next(e)
 })
 on('command.run',{command:"desktop-bookmark-dock"},async($,e)=>{
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
 return [input('label','Label',label,v=>{label=bounded(v.trim(),120);redraw()}),input('url','HTTP / HTTPS URL',url,v=>{url=bounded(v.trim(),2000);redraw()}),button('save','Save bookmark',async()=>{try{const u=new URL(url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Use an HTTP/HTTPS URL without embedded credentials.');const keys=(await $.store.keys()).filter(k=>k.startsWith(prefix+'item:'));if(keys.length>=100)throw Error('Limit is 100 bookmarks; delete one first.');await $.store.set(prefix+'item:'+crypto.randomUUID(),{label:label||u.hostname,url:u.href});url='';label='';message='Saved locally.';await load($)}catch(error){message=error.message}redraw()}),...items.map((x,i)=>row(E,[E.Link({href:x.url,label:x.label}),button('copy-'+i,'Copy URL',()=>copy(x.url)),button('delete-'+i,'Delete',async()=>{await $.store.delete(x.key);await load($)})])),text(E,message||'Links open only when clicked. Latest 100 workspace bookmarks.'),button('reload','Reload bookmarks',()=>load($))]
}
