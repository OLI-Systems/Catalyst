import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "edit-heatmap"
let files = {}
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Count successful Edit and Write calls by path.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"edit-heatmap"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Edit Heatmap",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call', {tool:['Edit','Write']}, async ($, e, next) => {
 const r = await next(e)
 if(!r.deny && !r.isError && typeof e.file_path === 'string') {
   if(Object.keys(files).length < 200 || files[e.file_path]) files[e.file_path]=(files[e.file_path]||0)+1
   $.ui.invalidate('ui.render')
 }
 return r
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Edit Heatmap","Count successful Edit and Write calls by path.",body)
    } catch(error) {
      return frame(E,"Edit Heatmap",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

const sorted = Object.entries(files).sort((a,b)=>b[1]-a[1])
const max = sorted[0]?.[1] || 1
return [text(E,'Successful file tool calls; Bash edits are not counted.'),
 ...sorted.map(([path,n])=>text(E,'#'.repeat(Math.ceil(n/max*12)).padEnd(13)+n+'  '+path)),
 ...(sorted.length ? []:[text(E,'No successful file edits observed yet.')]),refresh]

}
