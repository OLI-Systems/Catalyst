import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "base64-lab"
let mode="encode"
let source="Hello, mods!"
let output=""


function transform(){
 bounded(source)
 if(mode==='encode')return new TextEncoder().encode(source).toBase64()
 if(mode==='decode')return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.fromBase64(source,{lastChunkHandling:'strict'}))
 throw new Error('Mode must be encode or decode.')
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Encode UTF-8 text or decode strict Base64.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"base64-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Base64 Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Base64 Lab","Encode UTF-8 text or decode strict Base64.",body)
    } catch(error) {
      return frame(E,"Base64 Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"mode",label:"Mode: encode or decode",value:clean(mode),submitLabel:'apply',onSubmit:async(v)=>{mode=v;await calculate($)}}),
E.Input({key:"source",label:"Text / Base64",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
