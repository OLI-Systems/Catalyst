import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "ascii-flipbook"

let target='animation.txt',frames=['( o.o )\n > ^ <','( -.- )\n > ^ <'],index=0,playing=false,report='Built-in two-frame demo. Open a text file to load your own.'
async function load($){
 try {
  const p=safePath(target),s=await $.fs.stat(p)
  if(s.size>131072)throw new Error('Animation must be at most 128 KiB.')
  const f=(await $.fs.read(p)).split('\f')
  if(f.length>120||f.some(x=>x.length>4000))throw new Error('Use at most 120 frames of 4,000 characters each.')
  frames=f;index=0;report=f.length+' frames loaded.'
 } catch(error){report=error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    $.clock.every(500,()=>{if(playing){index=(index+1)%frames.length;$.ui.invalidate('ui.render')}})
    await $.command.register({name:ID, description:"Play a local text animation whose frames are separated by a form feed.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"ascii-flipbook"}, async ($, e) => {
    if(e.args.trim()){target=e.args.trim();await load($)}
    await $.ui.open({id:ID,title:"ASCII Flipbook",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"ASCII Flipbook","Play a local text animation whose frames are separated by a form feed.",body)
    } catch(error) {
      return frame(E,"ASCII Flipbook",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'Text animation',value:target,submitLabel:'load',onSubmit:async(v)=>{target=v;await load($)}}),
 text(E,'Frame '+(index+1)+' / '+frames.length,{bold:true}),code(E,frames[index]),
 row(E,[E.Button({key:'play',label:playing?'Pause':'Play',hotkey:'p',plain:true,onPress:()=>{playing=!playing;$.ui.invalidate('ui.render')}}),
 E.Button({key:'next',label:'Next frame',hotkey:'n',plain:true,onPress:()=>{index=(index+1)%frames.length;$.ui.invalidate('ui.render')}})]),text(E,report)]

}
