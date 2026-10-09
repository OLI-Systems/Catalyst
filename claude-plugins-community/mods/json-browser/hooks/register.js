import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "json-browser"
let target="package.json"
let report='Open a file to inspect it.'


function transform(source) {
 const p=JSON.parse(source)
 return entries(p).map(([k,v])=>k+' · '+(Array.isArray(v)?'array['+v.length+']':v===null?'null':typeof v)).join('\n')+'\n\n'+pretty(p)
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

    await $.command.register({name:ID, description:"Summarize top-level JSON keys with types and a formatted preview.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"json-browser"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"JSON Browser",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"JSON Browser","Summarize top-level JSON keys with types and a formatted preview.",body)
    } catch(error) {
      return frame(E,"JSON Browser",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 code(E,report,"json"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
