import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "command-history"
let commands=[]
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Keep the last 40 Bash command strings and copy one for reuse.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"command-history"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Command History",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call',{tool:'Bash'},async($,e,next)=>{
 const r=await next(e)
 commands=[...commands,clean(e.command,2000)].slice(-40)
 $.ui.invalidate('ui.render')
 return r
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Command History","Keep the last 40 Bash command strings and copy one for reuse.",body)
    } catch(error) {
      return frame(E,"Command History",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,'Observed Bash commands; may include private arguments.'),
 ...commands.map((c,i)=>row(E,[text(E,(i+1)+'. '+c),E.Button({key:'copy-'+i,label:'Copy',onPress:async()=>{const r=await $.ui.copy({text:c});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})])),
 ...(commands.length?[]:[text(E,'No Bash commands observed yet.')]),refresh]

}
