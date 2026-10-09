import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "regex-lab"
let pattern="APP-\\d+"
let flags="g"
let source="Fix APP-123 before APP-456"
let output=""


function transform() {
 bounded(source,2000);bounded(pattern,160)
 if(!/^[gimsuy]*$/.test(flags))throw new Error('Flags must be g, i, m, s, u, or y.')
 // Use a predictable subset rather than executing arbitrary backtracking patterns.
 let inClass=false,repeat=0
 for(let i=0;i<pattern.length;i++) {
  const c=pattern[i]
  if(c==='\\') {
   const escape=pattern[++i]
   if(/[1-9k]/.test(escape||''))throw new Error('Backreferences are refused.')
   continue
  }
  if(c==='[')inClass=true
  else if(c===']')inClass=false
  else if(!inClass) {
   if('()|'.includes(c))throw new Error('Groups and alternation are outside the supported subset.')
   if('*+?{'.includes(c) && ++repeat>1)throw new Error('Use at most one repetition operator in this lab.')
  }
 }
 const re=new RegExp(pattern,flags.includes('g')?flags:flags+'g')
 const found=Array.from(source.matchAll(re)).slice(0,40)
 return found.length+' matches\n\n'+found.map(m=>'['+m.index+', '+(m.index+m[0].length)+') '+m[0]).join('\n')
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Test a regular expression against text and see matched ranges.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"regex-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Regex Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Regex Lab","Test a regular expression against text and see matched ranges.",body)
    } catch(error) {
      return frame(E,"Regex Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [text(E,'Supported subset: character classes, anchors, escapes, and one repetition; no groups or alternation.'),E.Input({key:"pattern",label:"Pattern",value:clean(pattern),submitLabel:'apply',onSubmit:async(v)=>{pattern=v;await calculate($)}}),
E.Input({key:"flags",label:"Flags",value:clean(flags),submitLabel:'apply',onSubmit:async(v)=>{flags=v;await calculate($)}}),
E.Input({key:"source",label:"Text",value:clean(source),submitLabel:'apply',onSubmit:async(v)=>{source=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
