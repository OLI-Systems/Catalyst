import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "ignore-check"
let target = "dist/bundle.js"
let report = 'Open this pane to read Git state.'

async function load($) {
 try {
   const first = await $.process.run(["git", "--no-pager", "check-ignore", "-v", "--no-index", "--"].concat([safePath(target)]), {timeoutMs:10000})
   report = (first.exitCode === 0 ? first.stdout || 'No matching entries.' : first.stderr || 'No matching entries (exit '+first.exitCode+').')

 } catch(error) { report = 'Git inspection failed: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Explain which Git ignore rule matches a path.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"ignore-check"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"Ignore Check",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Ignore Check","Explain which Git ignore rule matches a path.",body)
    } catch(error) {
      return frame(E,"Ignore Check",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:"path to check",value:target,submitLabel:'inspect',onSubmit:async(value)=>{target=value;await load($)}}), code(E,report), E.Button({key:'refresh',label:'Refresh Git state',hotkey:'r',plain:true,onPress:()=>load($)})]

}
