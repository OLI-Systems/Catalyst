import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "log-viewer"
let target="app.log"
let report='Open a file to inspect it.'
let filter=''

function transform(source) {
 const lines=source.split('\n').filter(l=>!filter || l.toLowerCase().includes(filter.toLowerCase()))
 return lines.length+' matching lines · showing last 60\n\n'+lines.slice(-60).join('\n')
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

    await $.command.register({name:ID, description:"Show the last 60 lines of a small local log with an optional filter.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"log-viewer"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Log Viewer",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Log Viewer","Show the last 60 lines of a small local log with an optional filter.",body)
    } catch(error) {
      return frame(E,"Log Viewer",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 E.Input({key:'filter',label:'Contains',value:filter,submitLabel:'filter',onSubmit:async(v)=>{filter=v;await load($)}}), code(E,report,"text"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
