import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "url-lab"
let source="https://example.com/callback?state=hello%20world&mode=preview#result"
let output=""


function transform(){
 const u=new URL(bounded(source))
 return pretty({protocol:u.protocol,hostname:u.hostname,port:u.port||'(default)',path:u.pathname,fragment:u.hash,query:Array.from(u.searchParams.entries()),hasCredentials:!!(u.username||u.password)})
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Inspect URL components and decoded query parameters locally.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"url-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"URL Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"URL Lab","Inspect URL components and decoded query parameters locally.",body)
    } catch(error) {
      return frame(E,"URL Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"source",label:"URL",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
