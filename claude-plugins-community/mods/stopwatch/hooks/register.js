import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "stopwatch"
let elapsed=0,started=0,running=false,laps=[]
export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(1000,()=>{if(running)$.ui.invalidate('ui.render')})
    await $.command.register({name:ID, description:"Time a task with start, pause, and lap markers.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"stopwatch"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Stopwatch",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Stopwatch","Time a task with start, pause, and lap markers.",body)
    } catch(error) {
      return frame(E,"Stopwatch",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

const n=elapsed+(running?(await $.clock.now())-started:0)
return [text(E,(n/1000).toFixed(1)+' seconds',{bold:true,color:'cyan'}),
 row(E,[E.Button({key:'start',label:running?'Pause':'Start',onPress:async()=>{const now=await $.clock.now();if(running)elapsed+=now-started;else started=now;running=!running;$.ui.invalidate('ui.render')}}),
 E.Button({key:'lap',label:'Lap',onPress:async()=>{const n=elapsed+(running?(await $.clock.now())-started:0);laps=[...laps,n].slice(-20);$.ui.invalidate('ui.render')}}),
 E.Button({key:'reset',label:'Reset',onPress:()=>{elapsed=0;running=false;laps=[];$.ui.invalidate('ui.render')}})]),
 ...laps.map((x,i)=>text(E,'Lap '+(i+1)+' · '+(x/1000).toFixed(1)+'s'))]

}
