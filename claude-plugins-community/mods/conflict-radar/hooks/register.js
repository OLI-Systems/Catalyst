import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "conflict-radar"
let target = ""
let report = 'Open this pane to read Git state.'

async function load($) {
 try {
   const first = await $.process.run(["git", "--no-pager", "diff", "--name-only", "--diff-filter=U"], {timeoutMs:10000})
   report = (first.exitCode === 0 ? first.stdout || 'No matching entries.' : first.stderr || 'No matching entries (exit '+first.exitCode+').')
   const second = await $.process.run(["git", "--no-pager", "grep", "-n", "-I", "-E", "^(<<<<<<< |=======|>>>>>>> )", "--", "."], {timeoutMs:10000})
 report += '\n\n'+(second.stdout || second.stderr || 'No diff.')
 } catch(error) { report = 'Git inspection failed: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"List unresolved paths and count conflict markers in tracked files.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"conflict-radar"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Conflict Radar",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Conflict Radar","List unresolved paths and count conflict markers in tracked files.",body)
    } catch(error) {
      return frame(E,"Conflict Radar",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [ code(E,report), E.Button({key:'refresh',label:'Refresh Git state',hotkey:'r',plain:true,onPress:()=>load($)})]

}
