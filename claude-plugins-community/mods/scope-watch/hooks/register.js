import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "scope-watch"
let prefix='src/',warnings=[]
export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Warn when observed file edits leave a chosen path prefix.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"scope-watch"}, async ($, e) => {

    await $.ui.open({id:ID,title:"Scope Watch",focus:true,closeOnEscape:true})
    return {}
  })

on('tool.call',{tool:['Edit','Write']},async($,e,next)=>{
 const r=await next(e)
 const cwd=(await $.session.cwd()).replace(/\/$/,'')+'/'
 const path=e.file_path.startsWith(cwd)?e.file_path.slice(cwd.length):e.file_path
 if(!r.deny&&!r.isError&&!path.startsWith(prefix)){
  warnings=[...warnings,clean(path,500)].slice(-30)
  $.ui.toast('Edited outside watched prefix: '+clean(path,120))
  $.ui.invalidate('ui.render')
 }
 return r
})

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Scope Watch","Warn when observed file edits leave a chosen path prefix.",body)
    } catch(error) {
      return frame(E,"Scope Watch",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'prefix',label:'Expected path prefix',value:prefix,submitLabel:'watch',onSubmit:(v)=>{prefix=v.trim();warnings=[];$.ui.invalidate('ui.render')}}),
 text(E,'Advisory only. Bash and MCP edits are not detected.'),
 ...warnings.map(p=>text(E,p,{color:'yellow'})),
 ...(warnings.length?[]:[text(E,'No out-of-prefix edits observed.')]),refresh]

}
