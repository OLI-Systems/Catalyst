import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "agent-board"

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Inspect the subagents reported by the session.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"agent-board"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Agent Board",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Agent Board","Inspect the subagents reported by the session.",body)
    } catch(error) {
      return frame(E,"Agent Board",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

const agents = await $.agent.list()
return [text(E,'Subagents reported by this session',{bold:true}),
 ...agents.slice(0,40).map(a=>code(E,pretty(a),'json')),
 ...(agents.length?[]:[text(E,'No subagents currently reported.')]),refresh]

}
