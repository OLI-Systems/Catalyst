import {expect,test} from 'claude-code/testing'
import {world,site,bandSite} from './fixtures'
const ID="desktop-markdown-reader"

test('desktop command opens only on request',async($,on)=>{
 const {state}=world(on)
 await $.session.start({surface:'desktop',isInteractive:true,cwd:'/work'})
 expect(state.registered[0]).toMatchObject({name:ID,immediate:true})
 expect(state.opened).toEqual([])
 await $.command.run({command:ID,args:''})
 expect(state.opened[0]).toMatchObject({id:ID,focus:true,closeOnEscape:true})
})
test('other pane remains untouched',async($,on)=>{
 world(on)
 const ui=await $.ui.mount({...site(ID,'desktop'),requestId:'other'})
 expect(await ui.find({type:'Text',text:'Other pane untouched'})).toBeDefined()
 await ui.unmount()
})
for(const width of [36,84])test('desktop controls at width '+width,async($,on)=>{
 const {state,saved,clock}=world(on)
 await $.session.start({surface:'desktop',isInteractive:true,cwd:'/work'})
 await $.command.run({command:ID,args:''})
 const ui=await $.ui.mount(site(ID,'desktop',width))
 expect(await ui.find({type:'Text',text:"Desktop Markdown Reader"})).toBeDefined()
 await ui.input({key:'path',text:'README.md'});expect(await ui.find({type:'Markdown'})).toBeDefined();await ui.press({key:'tab-source'});expect((await ui.find({type:'Code'})).props.source).toContain('# Demo');await ui.press({key:'copy'});expect(state.copies[0]).toContain('## Setup');await ui.input({key:'path',text:'.env'});expect(state.reads.length).toBe(1);expect(await ui.find({type:'Text',text:'Choose a .md file.'})).toBeDefined()
 expect(await ui.find({type:'Text',text:/Unable to display:/})).toBeUndefined()
 await ui.unmount()
})
for(const surface of ['terminal',null] as const)test('explains unsupported surface '+surface,async($,on)=>{
 const {state}=world(on)
 await $.session.start({surface,isInteractive:surface!==null,cwd:'/work'})
 const r=await $.command.run({command:ID,args:''})
 expect(r.text).toContain('requires the Claude Desktop Code tab')
 expect(state.opened.length).toBe(0)
 expect(state.argv.length).toBe(0)
 expect(state.reads.length).toBe(0)
})
test('capture native render tree for fixture preview',async($,on)=>{
 const {state,saved,clock}=world(on)
 await $.session.start({surface:'desktop',isInteractive:true,cwd:'/work'})
 await $.command.run({command:ID,args:''})
 const ui=await $.ui.mount(site(ID,'desktop',84))
 await ui.input({key:'path',text:'README.md'})
 const tree=await ui.find({type:'Box'})
 expect(tree).toBeDefined()
 expect(await ui.find({type:'Text',text:/Unable to display:/})).toBeUndefined()
 console.log('MOD_PREVIEW:'+JSON.stringify({id:ID,surface:'desktop',tree}))
 await ui.unmount()
})
