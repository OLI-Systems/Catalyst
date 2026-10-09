import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "error-inbox"
let errors = []
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Keep the last 30 failed or refused tool calls in one pane.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"error-inbox"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Error Inbox",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call', async ($, e, next) => {
 const r = await next(e)
 if(r.deny || r.isError) {
   errors = [...errors,{tool:e.tool,reason:clean(r.deny || (typeof r.result === 'string' ? r.result : 'Tool returned an error'),500)}].slice(-30)
   $.ui.invalidate('ui.render')
 }
 return r
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Error Inbox","Keep the last 30 failed or refused tool calls in one pane.",body)
    } catch(error) {
      return frame(E,"Error Inbox",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,errors.length+' recent failures',{bold:true}),
 ...errors.map((x,i)=>text(E,(i+1)+'. '+x.tool+' · '+x.reason,{color:'yellow'})),
 ...(errors.length ? []:[text(E,'No failed calls observed. Keep going.')]),
 E.Button({key:'clear',label:'Clear inbox',onPress:()=>{errors=[];$.ui.invalidate('ui.render')}})]

}
