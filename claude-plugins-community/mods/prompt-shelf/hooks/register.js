import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "prompt-shelf"

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
    await $.command.register({name:ID, description:"Save reusable prompts and put one into the composer as a draft.", immediate:true, argumentHint:"[entry]"})
    return next(e)
  })
  on('command.run', {command:"prompt-shelf"}, async ($, e) => {
    await load($)
if(e.args.trim()) await save($,e.args)
    await $.ui.open({id:ID,title:"Prompt Shelf",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Prompt Shelf","Save reusable prompts and put one into the composer as a draft.",body)
    } catch(error) {
      return frame(E,"Prompt Shelf",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [text(E,"Reusable prompts"+' · '+items.length+' items',{bold:true}),
 E.Input({key:'entry',label:"Prompt",value:'',placeholder:'Type and press Enter',submitLabel:'save',onSubmit:(v)=>save($,v)}),
 ...items.map((item,i)=>E.Box({flexDirection:'column',children:[row(E,[text(E,item.text),E.Button({key:'draft-'+i,label:'Draft',onPress:async()=>{const r=await $.prompt.fill({text:item.text});message=r.isFilled?'Draft placed in composer; review and send it yourself.':'Composer is busy; draft was not placed.';$.ui.invalidate('ui.render')}})]),E.Button({key:'delete-'+i,label:'Delete',plain:true,dimColor:true,onPress:async()=>{await $.store.delete(item.key);await load($)}})]})),
  text(E,message || 'Saved per workspace. Refresh to see changes from other sessions.',{dimColor:true}),
 E.Button({key:'refresh',label:'Reload saved items',onPress:()=>load($)})]

}
