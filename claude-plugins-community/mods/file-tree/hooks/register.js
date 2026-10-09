import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "file-tree"
let target='.'
let listing=[]
let report=''

async function load($) {
 try { listing=(await $.fs.list(safePath(target))).slice(0,100); report='' }
 catch(error) { listing=[];report=error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Browse one directory at a time with clickable folders.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"file-tree"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"File Tree",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"File Tree","Browse one directory at a time with clickable folders.",body)
    } catch(error) {
      return frame(E,"File Tree",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'Directory',value:target,submitLabel:'browse',onSubmit:async(v)=>{target=v;await load($)}}),
 text(E,report || 'Up to 100 entries. Symlinks are shown but not followed by buttons.'),
 ...listing.map((f,i)=>f.kind==='dir'&&!f.isLink ? E.Button({key:'dir-'+i,label:'[dir] '+f.name,plain:true,onPress:async()=>{target=target.replace(/\/$/,'')+'/'+f.name;await load($)}}):text(E,(f.isLink?'[link] ':'[file] ')+f.name+'  '+(f.size||0)+' B')),
 E.Button({key:'refresh',label:'Refresh directory',onPress:()=>load($)})]

}
