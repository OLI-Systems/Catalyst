import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "staged-review"
let target = ""
let report = 'Open this pane to read Git state.'

async function load($) {
 try {
   const first = await $.process.run(["git", "--no-pager", "diff", "--cached", "--stat"], {timeoutMs:10000})
   report = (first.exitCode === 0 ? first.stdout || 'No matching entries.' : first.stderr || 'No matching entries (exit '+first.exitCode+').')
   const second = await $.process.run(["git", "--no-pager", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=2"], {timeoutMs:10000})
 report += '\n\n'+(second.stdout || second.stderr || 'No diff.')
 } catch(error) { report = 'Git inspection failed: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Review the staged diff before committing.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"staged-review"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Staged Review",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Staged Review","Review the staged diff before committing.",body)
    } catch(error) {
      return frame(E,"Staged Review",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [ code(E,report), E.Button({key:'refresh',label:'Refresh Git state',hotkey:'r',plain:true,onPress:()=>load($)})]

}
