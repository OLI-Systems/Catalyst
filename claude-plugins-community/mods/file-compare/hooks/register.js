import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "file-compare"
let left='before.txt',right='after.txt',report=''

async function load($) {
 try {
 const a=await $.fs.stat(safePath(left)),b=await $.fs.stat(safePath(right))
 if(a.size>65536||b.size>65536)throw new Error('Each file must be at most 64 KiB.')
 const x=(await $.fs.read(left)).split('\n'),y=(await $.fs.read(right)).split('\n')
 const diff=[]
 for(let i=0;i<Math.max(x.length,y.length);i++) if(x[i]!==y[i])diff.push((i+1)+': - '+(x[i]??'[missing]')+'\n   + '+(y[i]??'[missing]'))
 report=diff.length?diff.length+' differing line positions (positional comparison)\n\n'+diff.slice(0,100).join('\n'):'Files are identical.'
 } catch(error){report=error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Compare two small text files by line without editing either.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"file-compare"}, async ($, e) => {
    await load($)
    await $.ui.open({id:ID,title:"File Compare",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"File Compare","Compare two small text files by line without editing either.",body)
    } catch(error) {
      return frame(E,"File Compare",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'left',label:'Left file',value:left,submitLabel:'set',onSubmit:async(v)=>{left=v;await load($)}}),
 E.Input({key:'right',label:'Right file',value:right,submitLabel:'compare',onSubmit:async(v)=>{right=v;await load($)}}),
 code(E,report),E.Button({key:'refresh',label:'Compare again',onPress:()=>load($)})]

}
