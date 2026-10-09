import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "text-counter"
let source="Build small tools. Make them useful."
let output=""


function transform(){bounded(source);return pretty({words:source.trim()?source.trim().split(/\s+/).length:0,lines:source?source.split('\n').length:0,codePoints:Array.from(source).length,utf8Bytes:new TextEncoder().encode(source).length})}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Count words, lines, Unicode code points, and UTF-8 bytes.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"text-counter"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Text Counter",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Text Counter","Count words, lines, Unicode code points, and UTF-8 bytes.",body)
    } catch(error) {
      return frame(E,"Text Counter",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"source",label:"Text",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
