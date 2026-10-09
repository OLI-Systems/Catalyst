import { clean, text, code, row, frame, bar, pretty, bounded, entries, safePath } from './ui.js'
const ID = "csv-table"
let target="data.csv"
let report='Open a file to inspect it.'


export function parseCSV(source) {
 const rows=[];let row=[],cell='',quoted=false
 for(let i=0;i<source.length;i++) {
  const c=source[i]
  if(c==='"') { if(quoted&&source[i+1]==='"'){cell+='"';i++}else if(quoted || cell==='')quoted=!quoted;else throw new Error('Quote inside unquoted CSV field.') }
  else if(c===','&&!quoted){row.push(cell);cell=''}
  else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell=''}
  else cell+=c
 }
 if(quoted)throw new Error('CSV has an unclosed quoted field.')
 if(cell || row.length){row.push(cell.replace(/\r$/,''));rows.push(row)}
 return rows
}
function transform(source) {
 const rows=parseCSV(source)
 if(!rows.length)return 'Empty CSV.'
 return Math.max(0,rows.length-1)+' data rows · '+rows[0].length+' columns\n\n'+rows.slice(0,26).map(r=>r.map(c=>c.replace(/\n/g,' ↵ ').slice(0,24).padEnd(25)).join(' | ')).join('\n')
}


async function load($) {
 try {
  const path = safePath(target)
  const info = await $.fs.stat(path)
  if(info.size > 262144) throw new Error('File exceeds the 256 KiB viewer limit.')
  const source = await $.fs.read(path)
  report = transform(source)
 } catch(error) { report='Could not inspect file: '+error.message }
 $.ui.invalidate('ui.render')
}

export function register(on) {
  on('session.start', async ($, e, next) => {

    await $.command.register({name:ID, description:"Preview quoted CSV fields, row counts, and column headers.", immediate:true, argumentHint:"[path]"})
    return next(e)
  })
  on('command.run', {command:"csv-table"}, async ($, e) => {
    if(e.args.trim()) target=e.args.trim()
await load($)
    await $.ui.open({id:ID,title:"CSV Table",focus:true,closeOnEscape:true})
    return {}
  })

  on('ui.render', {component:'Pane'}, async ($, e, next) => {
    if(e.requestId !== ID) return next(e)
    const E = $.ui.resolve(e)
    try {
      const body = await draw($, E)
      return frame(E,"CSV Table","Preview quoted CSV fields, row counts, and column headers.",body)
    } catch(error) {
      return frame(E,"CSV Table",'Unable to inspect this data.',[text(E,error.message,{color:'yellow'}),E.Button({key:'refresh',label:'Refresh',onPress:()=>$.ui.invalidate('ui.render')})])
    }
  })
}
async function draw($, E) {
  const refresh = E.Button({key:'refresh',label:'Refresh',hotkey:'r',plain:true,onPress:()=>$.ui.invalidate('ui.render')})

return [E.Input({key:'target',label:'File',value:target,submitLabel:'open',onSubmit:async(value)=>{target=value;await load($)}}),
 code(E,report,"text"),E.Button({key:'refresh',label:'Read file again',onPress:()=>load($)})]

}
