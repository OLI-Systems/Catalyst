import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "env-example"
let target=".env.example"
let report='Open a file to inspect it.'


function transform(source) {
 return source.split('\n').flatMap((line,i)=>{
  const m=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  return m ? [(i+1)+': '+m[1]+' · '+(m[2].trim()?'example value provided':'value needed')] : []
 }).join('\n') || 'No variable assignments found.'
}


async function load($) {
 try {
  const path = safePath(target)
  if(!/(?:^|\/)\.?env(?:\.[\w-]+)*\.(example|sample|template)$/.test(path)) throw new Error('Choose an env example, sample, or template file; real env files are refused.')
  const info = await $.fs.stat(path)
  if(info.isLink)throw new Error('Symlink env example files are refused.')
  if(info.size > 262144) throw new Error('File exceeds the 256 KiB viewer limit.')
  const source = await $.fs.read(path)
  report = transform(source)
 } catch(error) { report='Could not inspect file: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"List variable names and missing placeholders in an example env file.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"env-example"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Env Example",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Env Example","List variable names and missing placeholders in an example env file.",body)
    } catch(error) {
      return frame(E,"Env Example",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 code(E,report,"text"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
