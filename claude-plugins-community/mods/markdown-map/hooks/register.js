import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "markdown-map"
let target="README.md"
let report='Open a file to inspect it.'


function transform(source) {
 let fence=null
 return source.split('\n').flatMap((line,i)=>{
  const f=line.match(/^\s{0,3}(`{3,}|~{3,})/)
  if(f) { if(!fence) fence=f[1][0];else if(fence===f[1][0])fence=null;return [] }
  if(fence)return []
  const m=line.match(/^(#{1,6})\s+(.+)/)
  return m ? [(i+1).toString().padStart(4)+'  '+'  '.repeat(m[1].length-1)+m[2].replace(/\s+#+\s*$/,'')] : []
 }).join('\n') || 'No ATX headings outside fenced code.'
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

    await $.command.register({name:ID, description:"Build a heading outline with source line numbers.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"markdown-map"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Markdown Map",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Markdown Map","Build a heading outline with source line numbers.",body)
    } catch(error) {
      return frame(E,"Markdown Map",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 code(E,report,"text"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
