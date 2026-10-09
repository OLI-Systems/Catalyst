import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "cache-inspector"
let records = []
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Track API cache reads, writes, and uncached input by request.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"cache-inspector"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Cache Inspector",focus:true,closeOnEscape:true})
    return {}
  })

on('turn.step', async function* ($, e, next) {
  const result = yield* next(e)
  if(result.usage) {
    records = [...records, {model:e.model, agent:e.agentId || 'main', ...result.usage}].slice(-30)
    $.ui.invalidate('ui.render')
  }
  return result
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Cache Inspector","Track API cache reads, writes, and uncached input by request.",body)
    } catch(error) {
      return frame(E,"Cache Inspector",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,'Latest 30 completed requests; counts from API reports.'),
  ...records.map((r,i)=>text(E,(i+1)+'. '+r.agent+' · '+r.model+'\nRead '+(r.cache_read_input_tokens||0)+' · wrote '+(r.cache_creation_input_tokens||0)+' · uncached '+(r.input_tokens||0))),
  ...(records.length ? [] : [text(E,'No completed requests observed yet.')]), refresh]

}
