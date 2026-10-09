import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "time-lab"
let source="2026-10-03T09:00:00Z"
let output=""


function transform(){
 const s=source.trim()
 const n=/^-?\d+$/.test(s)?Number(s):null
 const d=new Date(n===null?s:(Math.abs(n)<1e11?n*1000:n))
 if(!Number.isFinite(d.getTime()))throw new Error('Use Unix seconds/milliseconds or an ISO date.')
 return 'UTC: '+d.toISOString()+'\nUnix seconds: '+Math.floor(d.getTime()/1000)+'\nUnix milliseconds: '+d.getTime()
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Convert Unix seconds, milliseconds, or an ISO date to UTC.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"time-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Time Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Time Lab","Convert Unix seconds, milliseconds, or an ISO date to UTC.",body)
    } catch(error) {
      return frame(E,"Time Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"source",label:"Timestamp",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
