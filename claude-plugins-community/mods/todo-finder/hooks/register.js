import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "todo-finder"
let report=''

async function load($) {
 try {
  const r=await $.process.run(['git','--no-pager','grep','-n','-I','-E','TODO|FIXME|HACK','--','.'],{timeoutMs:10000})
  report=r.exitCode===0?r.stdout:(r.exitCode===1?'No TODO, FIXME, or HACK markers in tracked files.':r.stderr)
 } catch(error) { report=error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Find TODO, FIXME, and HACK notes in tracked files.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"todo-finder"}, async ($, e) => {
    await load($)
    await $.ui.open({id:ID,title:"TODO Finder",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"TODO Finder","Find TODO, FIXME, and HACK notes in tracked files.",body)
    } catch(error) {
      return frame(E,"TODO Finder",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [code(E,report),E.Button({key:'refresh',label:'Search tracked files',onPress:()=>load($)})]
}
