import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "color-lab"
let foreground="#86efac"
let background="#0f172a"
let output=""


function rgb(s){if(!/^#[0-9a-f]{6}$/i.test(s))throw new Error('Use six-digit #RRGGBB colors.');return [1,3,5].map(i=>parseInt(s.slice(i,i+2),16))}
function luminance(c){return c.map(x=>{const v=x/255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}).reduce((s,x,i)=>s+x*[0.2126,0.7152,0.0722][i],0)}
function transform(){
 const a=rgb(foreground),b=rgb(background),x=luminance(a),y=luminance(b)
 const ratio=(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)
 return 'Foreground RGB: '+a.join(', ')+'\nBackground RGB: '+b.join(', ')+'\nContrast: '+ratio.toFixed(2)+':1\n'+(ratio>=4.5?'Meets 4.5:1 threshold for normal text.':'Below 4.5:1 threshold for normal text.')
}

async function calculate($) {
 try { output=await transform() } catch(error){output='Invalid input: '+error.message}
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Convert hex colors and measure contrast against a background.", immediate:true, argumentHint:""})
    return next(e)
  })
  on('command.run', {command:"color-lab"}, async ($, e) => {
    await calculate($)
    await $.ui.open({id:ID,title:"Color Lab",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"Color Lab","Convert hex colors and measure contrast against a background.",body)
    } catch(error) {
      return frame(E,"Color Lab",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})
return [E.Input({key:"foreground",label:"Foreground hex",value:clean(foreground),submitLabel:'apply',onSubmit:async(v)=>{foreground=v;await calculate($)}}),
E.Input({key:"background",label:"Background hex",value:clean(background),submitLabel:'apply',onSubmit:async(v)=>{background=v;await calculate($)}}),code(E,output),E.Button({key:'copy',label:'Copy result',onPress:async()=>{const r=await $.ui.copy({text:output});if(!r.isCopied)$.ui.toast('Clipboard unavailable.')}})]
}
