import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "test-ledger"
let runs=[]
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Record likely test, lint, and build commands and their tool status.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"test-ledger"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Test Ledger",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call',{tool:'Bash'},async($,e,next)=>{
 const r=await next(e)
 if(/\b(test|pytest|vitest|jest|tsc|lint|build)\b/.test(e.command)){
  runs=[...runs,{command:clean(e.command,240),status:r.deny?'refused':r.isError?'tool error':'tool completed'}].slice(-30)
  $.ui.invalidate('ui.render')
 }
 return r
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Test Ledger","Record likely test, lint, and build commands and their tool status.",body)
    } catch(error) {
      return frame(E,"Test Ledger",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,'Command detection is heuristic. Tool completion does not prove tests passed.'),
 ...runs.map((r,i)=>text(E,(i+1)+'. '+r.status+'\n'+r.command)),
 ...(runs.length?[]:[text(E,'No likely validation commands observed yet.')]),refresh]

}
