import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "focus-clock"
let remaining=25*60, running=false, last=0
export function register(on) {
  on('session.start', async ($, e, next) => {

$.clock.every(1000,async()=>{
 if(!running)return
 const now=await $.clock.now()
 remaining=Math.max(0,remaining-(now-last)/1000);last=now
 if(remaining===0){running=false;$.ui.toast('Focus interval finished. Take a break.')}
 $.ui.invalidate('ui.render')
})

    await $.command.register({name:ID, description:"Run a 25-minute focus countdown with pause, reset, and a toast.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"focus-clock"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Focus Clock",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Focus Clock","Run a 25-minute focus countdown with pause, reset, and a toast.",body)
    } catch(error) {
      return frame(E,"Focus Clock",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

const seconds=Math.ceil(remaining)
return [text(E,Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0'),{bold:true,color:'cyan'}),
 text(E,running?'Focus interval is running.':'Ready or paused.'),
 row(E,[E.Button({key:'start',label:running?'Pause':'Start',hotkey:'s',plain:true,onPress:async()=>{const now=await $.clock.now();if(running)remaining=Math.max(0,remaining-(now-last)/1000);last=now;running=!running;$.ui.invalidate('ui.render')}}),
 E.Button({key:'reset',label:'Reset 25 minutes',onPress:()=>{running=false;remaining=1500;$.ui.invalidate('ui.render')}})])]

}
