import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "read-only-mode"
let enabled=false,blocked=0
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Toggle a reminder guard that refuses built-in mutating tools and Bash.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"read-only-mode"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Read-only Mode",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call',{tool:['Edit','Write','NotebookEdit','Bash']},async($,e,next)=>{
 if(!enabled)return next(e)
 blocked+=1;$.ui.invalidate('ui.render')
 return {deny:'Read-only Mode is enabled. Use inspection tools or ask the user to disable it in /read-only-mode.'}
}).catch(async()=>({deny:'Read-only Mode guard failed; this call was refused.'}))

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Read-only Mode","Toggle a reminder guard that refuses built-in mutating tools and Bash.",body)
    } catch(error) {
      return frame(E,"Read-only Mode",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,enabled?'Guard ON':'Guard OFF',{bold:true,color:enabled?'green':'yellow'}),
 text(E,'Blocks Edit, Write, NotebookEdit, and all Bash calls. MCP and other mods are outside this reminder guard.'),
 text(E,blocked+' calls refused'),
 E.Button({key:'toggle',label:enabled?'Disable guard':'Enable guard',onPress:()=>{enabled=!enabled;$.ui.invalidate('ui.render')}})]

}
