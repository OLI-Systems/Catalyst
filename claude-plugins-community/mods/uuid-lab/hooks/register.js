import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "uuid-lab"
let count="3"
let output=""


function transform(){const n=Number(count);if(!Number.isInteger(n)||n<1||n>20)throw new Error('Count must be an integer from 1 to 20.');return Array.from({length:n},()=>crypto.randomUUID()).join('\n')}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Generate up to 20 random UUID v4 values locally.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"uuid-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"UUID Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"UUID Lab","Generate up to 20 random UUID v4 values locally.",body)
    } catch(error) {
      return frame(E,"UUID Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"count",label:"Count (1\u201320)",value:clean(count),submitLabel:'apply',onSubmit:async(v)=>{count=v;await calculate($)}}),code(E,output),E.Button({key:'generate',label:'Generate new IDs',onPress:()=>calculate($)}),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
