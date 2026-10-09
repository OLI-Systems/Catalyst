import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "package-scripts"
let target="package.json"
let report='Open a file to inspect it.'


function transform(source) {
 const p=JSON.parse(source)
 return (p.name||'Unnamed package')+' @ '+(p.version||'?')+'\n\n'+entries(p.scripts).map(([k,v])=>k+'\n  '+v).join('\n')
}


async function load($) {
 try {
  const path = safePath(target)
  const info = await $.fs.stat(path)
  if(info.size > 262144) throw new Error('File exceeds the 256 KiB viewer limit.')
  const source = await $.fs.read(path)
  report = transform(source)
 } catch(error) { report='Could not inspect file: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"List npm scripts and package identity without running them.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"package-scripts"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Package Scripts",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Package Scripts","List npm scripts and package identity without running them.",body)
    } catch(error) {
      return frame(E,"Package Scripts",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 code(E,report,"text"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
