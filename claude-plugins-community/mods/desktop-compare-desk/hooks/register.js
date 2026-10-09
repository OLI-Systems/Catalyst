import {clean,text,code,row,frame,bounded,path,xml,num,pct,count,waitUntil,chart,gauge,columns,usageChips,strip} from './ui.js'
const ID="desktop-compare-desk", TITLE="Desktop Compare Desk"
let surface=null,prefix=''
let left='before.txt',right='after.txt',a='',b='',message='Load two files to compare.'

async function readText($,target){const chosen=path(target),p=/^(\/|[A-Za-z]:[\\/])/.test(chosen)?chosen:(await $.session.cwd()).replace(/[\\/]$/,'')+'/'+chosen,s=await $.fs.stat(p);if(s.kind!=='file'||s.isLink||s.size>131072)throw Error('Choose a regular non-symlink text file up to 128 KiB.');const content=await $.fs.read(p);if(content.includes('\0'))throw Error('Binary files are not supported.');return clean(content)}

function changedLines(a,b){const x=a.split('\n'),y=b.split('\n');return Array.from({length:Math.max(x.length,y.length)},(_,i)=>i).filter(i=>x[i]!==y[i]).length}

export function register(on){
 on('session.start',async($,e,next)=>{
  surface=e.surface;prefix='workspace:'+encodeURIComponent(e.cwd)+':'
  await $.command.register({name:ID,description:"Compare two local text files in responsive side-by-side columns.",immediate:true})
  if(surface==='desktop'){}
  return next(e)
 })
 on('command.run',{command:"desktop-compare-desk"},async($,e)=>{
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
 const aa=a.split('\n'),bb=b.split('\n'),n=Math.max(aa.length,bb.length),changed=Array.from({length:n},(_,i)=>i).filter(i=>aa[i]!==bb[i])
return [input('left','Left file',left,v=>{left=path(v);redraw()}),input('right','Right file',right,v=>{right=path(v);redraw()}),button('load','Compare files',async()=>{try{const x=await readText($,left),y=await readText($,right);a=x;b=y;message='Compared preview: '+changedLines(x,y)+' differing line positions.'}catch(error){a='';b='';message=error.message}redraw()}),text(E,message),columns(E,e,[[text(E,left,{bold:true}),code(E,a||'No left preview.')],[text(E,right,{bold:true}),code(E,b||'No right preview.')]]),text(E,changed.length?'Changed line positions: '+changed.slice(0,40).map(i=>i+1).join(', '):'No differing preview lines.'),text(E,'Position comparison, not an insertion-aware diff. Each preview is bounded to 9,000 characters.') ]
}
