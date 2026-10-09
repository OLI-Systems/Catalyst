import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "turn-timeline"
let turns = []
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Show duration, token totals, and interruption state per turn.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"turn-timeline"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Turn Timeline",focus:true,closeOnEscape:true})
    return {}
  })

on('turn.complete', async ($, e, next) => {
 turns = [...turns,{duration:e.durationMs,aborted:e.isAborted,agent:e.agentId||'main',output:e.usage?.output_tokens||0}].slice(-30)
 $.ui.invalidate('ui.render')
 return next(e)
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Turn Timeline","Show duration, token totals, and interruption state per turn.",body)
    } catch(error) {
      return frame(E,"Turn Timeline",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,'Latest 30 observed turns',{bold:true}), ...turns.map((t,i)=>text(E,
 (i+1)+'. '+t.agent+' · '+(t.duration/1000).toFixed(1)+'s · '+t.output+' output tokens'+(t.aborted?' · interrupted':''))),
 ...(turns.length?[]:[text(E,'Complete a turn to begin the timeline.')]),refresh]

}
