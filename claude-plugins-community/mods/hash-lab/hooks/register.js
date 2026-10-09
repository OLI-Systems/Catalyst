import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "hash-lab"
let algorithm="SHA-256"
let source="hello"
let output=""


async function transform(){
 if(!['SHA-256','SHA-384','SHA-512'].includes(algorithm))throw new Error('Use SHA-256, SHA-384, or SHA-512.')
 const digest=await crypto.subtle.digest(algorithm,new TextEncoder().encode(bounded(source)))
 return algorithm+'\n'+Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('')
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Calculate SHA-256, SHA-384, or SHA-512 for UTF-8 text.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"hash-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Hash Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Hash Lab","Calculate SHA-256, SHA-384, or SHA-512 for UTF-8 text.",body)
    } catch(error) {
      return frame(E,"Hash Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"algorithm",label:"Algorithm",value:clean(algorithm),submitLabel:'apply',onSubmit:async(v)=>{algorithm=v;await calculate($)}}),
E.Input({key:"source",label:"Text",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
