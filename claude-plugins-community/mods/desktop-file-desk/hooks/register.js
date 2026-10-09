import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-file-desk", TITLE="Desktop File Desk"
let surface=null,prefix=''
let target='README.md',source='',filter='',message='Choose a file to read.'

async function readText($,target){const chosen=path(target),p=/^(\/|[A-Za-z]:[\\/])/.test(chosen)?chosen:(await $.session.cwd()).replace(/[\\/]$/,'')+'/'+chosen,s=await $.fs.stat(p);if(s.kind!=='file'||s.isLink||s.size>131072)throw Error('Choose a regular non-symlink text file up to 128 KiB.');const content=await $.fs.read(p);if(content.includes('\0'))throw Error('Binary files are not supported.');return clean(content)}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Read a bounded text file with line filtering and path drafting.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-file-desk"},async($,e)=>{
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
 const lines=source.split('\n').map((s,i)=>(i+1)+': '+s).filter(s=>!filter||s.toLowerCase().includes(filter.toLowerCase())).slice(0,100)
return [input('path','Text file',target,async(v)=>{try{target=path(v);source=await readText($,target);message='Read '+target}catch(error){source='';message=error.message}redraw()}),input('filter','Filter lines',filter,v=>{filter=bounded(v,200);redraw()}),text(E,message),code(E,source?lines.join('\n'):'No file loaded.'),button('draft','Draft a question',async()=>{const r=await $.prompt.fill({text:'Review '+target+' and explain the relevant lines.'});if(!r.isFilled)$.ui.toast('Composer unavailable.')})]
}
