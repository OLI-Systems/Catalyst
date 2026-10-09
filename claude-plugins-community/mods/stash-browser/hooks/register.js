import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "stash-browser"
let target = "stash@{0}"
let report = 'Open this pane to read Git state.'

async function load($) {
 try {
 if(!/^stash@\{\d+\}$/.test(target)) throw new Error('Use a stash reference such as stash@{0}.')
   const first = await $.process.run(["git", "--no-pager", "stash", "list", "--format=%gd  %s"], {timeoutMs:10000})
   report = (first.exitCode === 0 ? first.stdout || 'No matching entries.' : first.stderr || 'No matching entries (exit '+first.exitCode+').')
   const second = await $.process.run(["git", "--no-pager", "stash", "show", "--no-ext-diff", "--no-textconv", "--stat"].concat([target]), {timeoutMs:10000})
 report += '\n\n'+(second.stdout || second.stderr || 'No diff.')
 } catch(error) { report = 'Git inspection failed: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"List stashes and inspect a selected stash diff.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"stash-browser"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Stash Browser",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Stash Browser","List stashes and inspect a selected stash diff.",body)
    } catch(error) {
      return frame(E,"Stash Browser",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:"stash reference",value:target,submitLabel:'inspect',onSubmit:async(value)=>{target=value;await load($)}}), code(E,report), E.Button({key:'refresh',label:'Refresh Git state',hotkey:'r',plain:true,onPress:()=>load($)})]

}
