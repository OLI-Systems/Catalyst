import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "handoff-notes"

let prefix=''
let items=[]
let message=''
async function load($) {
 const keys=(await $.store.keys()).filter(k=>k.startsWith(prefix)).sort().slice(-100)
 items=[]
 for(const key of keys) {
  const item=await $.store.get(key)
  if(item && typeof item.text==='string')items.push({...item,key})
 }
 $.ui.invalidate('ui.render')
}
async function save($, value) {
 try {
  const content=bounded(value.trim(),4000)
  if(!content)return

  const date=new Date(await $.clock.now()).toISOString()
  const key=prefix+date+'-'+crypto.randomUUID()
  await $.store.set(key,{text:content,done:false,date})
  message='Saved locally.'
  await load($)
 } catch(error){message=error.message;$.ui.invalidate('ui.render')}
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    prefix='workspace:'+encodeURIComponent(e.cwd)+':item:'
await load($)
    await $.command.register({name:ID, description:"Keep a dated list of progress and next steps, then copy it.", immediate:true, argumentHint:"[entry]"})
    return next(e)
  })
  on('command.run', {command:"handoff-notes"}, async ($, e) => {
    await load($)
if(e.args.trim()) await save($,e.args)
    await $.ui.open({id:ID,title:"Handoff Notes",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Handoff Notes","Keep a dated list of progress and next steps, then copy it.",body)
    } catch(error) {
      return frame(E,"Handoff Notes",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,"Handoff notes"+' · '+items.length+' items',{bold:true}),
 E.Input({key:'entry',label:"Handoff note",value:'',placeholder:'Type and press Enter',submitLabel:'save',onSubmit:(v)=>save($,v)}),
 ...items.map((item,i)=>E.Box({flexDirection:'column',children:[text(E,item.date.slice(0,16).replace('T',' ')+' UTC\n'+item.text),E.Button({key:'delete-'+i,label:'Delete',plain:true,dimColor:true,onPress:async()=>{await $.store.delete(item.key);await load($)}})]})),
 E.Button({key:'copy-all',label:'Copy handoff',onPress:async()=>{const r=await $.ui.copy({text:items.map(x=>x.date+' '+x.text).join('\n')});message=r.isCopied?'Handoff copied.':'Clipboard unavailable.';$.ui.invalidate('ui.render')}}), text(E,message || 'Saved per workspace. Refresh to see changes from other sessions.',{dimColor:true}),
 E.Button({key:'refresh',label:'Reload saved items',onPress:()=>load($)})]

}
