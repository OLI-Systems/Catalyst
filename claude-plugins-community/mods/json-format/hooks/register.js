import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "json-format"
let source="{\"name\":\"mods\",\"count\":50,\"open\":true}"
let output=""

function transform(){return pretty(JSON.parse(bounded(source)))}
async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Validate and pretty-print JSON without touching a file.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"json-format"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"JSON Format",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"JSON Format","Validate and pretty-print JSON without touching a file.",body)
    } catch(error) {
      return frame(E,"JSON Format",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"source",label:"JSON",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
