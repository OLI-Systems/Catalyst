import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-markdown-reader", TITLE="Desktop Markdown Reader"
let surface=null,prefix=''
let target='README.md',source='',tab='preview',message='Choose a Markdown file.'

async function readText($,target){const chosen=path(target),p=/^(\/|[A-Za-z]:[\\/])/.test(chosen)?chosen:(await $.session.cwd()).replace(/[\\/]$/,'')+'/'+chosen,s=await $.fs.stat(p);if(s.kind!=='file'||s.isLink||s.size>131072)throw Error('Choose a regular non-symlink text file up to 128 KiB.');const content=await $.fs.read(p);if(content.includes('\0'))throw Error('Binary files are not supported.');return clean(content)}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Render a local Markdown document with a source tab.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-markdown-reader"},async($,e)=>{
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
 return [input('path','Markdown file',target,async(v)=>{try{const p=path(v);if(!/\.md$/i.test(p))throw Error('Choose a .md file.');target=p;source=await readText($,target);message='Loaded '+target}catch(error){source='';message=error.message}redraw()}),row(E,['preview','source'].map(t=>button('tab-'+t,t,()=>{tab=t;redraw()}))),text(E,message),...(source?[tab==='preview'?E.Markdown({text:source}):code(E,source)]:[text(E,'No document loaded.')]),button('copy','Copy Markdown source',()=>copy(source))]
}
