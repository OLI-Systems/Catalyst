import { expect, test } from 'claude-code/testing'
import { world, site } from './fixtures'
const ID="edit-heatmap"

test('registers an immediate command and opens only its pane', async ($, on) => {
 const {state}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 expect(state.registered.length).toBe(1)
 expect(state.registered[0].name).toBe(ID)
 expect(state.registered[0].immediate).toBe(true)
 expect(state.opened).toEqual([])
 await $.command.run({command:ID,args:''})
 expect(state.opened[0]).toMatchObject({id:ID,title:"Edit Heatmap",focus:true,closeOnEscape:true})
})

test('leaves another plugin pane untouched', async ($, on) => {
 world(on)
 const ui=await $.ui.mount({...site(ID),requestId:'someone-else'})
 expect(await ui.find({type:'Text',text:'Other pane untouched'})).toBeDefined()
 await ui.unmount()
})

for(const surface of ['terminal','desktop'] as const) {
 test('valid controls and behavior on '+surface, async ($,on)=>{
  const {state,saved,clock}=world(on)
  await $.session.start({surface,isInteractive:true,cwd:'/work'})
  await $.command.run({command:ID,args:''})
  const ui=await $.ui.mount(site(ID,surface,surface==='terminal'?34:70))
  expect(await ui.find({type:'Text',text:"Edit Heatmap"})).toBeDefined()
  expect(await ui.find({type:'Text',text:'Unable to inspect this data.'})).toBeUndefined()

await $.tool.call({tool:'Write',file_path:'/work/src/index.ts',content:'hello'})
state.failTool=true
await $.tool.call({tool:'Write',file_path:'/work/src/failed.ts',content:'hello'})
expect(await ui.find({type:'Text',text:/1  \/work\/src\/index.ts/})).toBeDefined()
expect(await ui.find({type:'Text',text:/failed.ts/})).toBeUndefined()

  await ui.unmount()
 })
}


test('capture native render tree for fixture preview', async($,on)=>{
 const {state,saved,clock}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 await $.command.run({command:ID,args:''})
 const ui=await $.ui.mount(site(ID,'terminal',78))
 for(let i=0;i<5;i++)await $.tool.call({tool:'Write',file_path:'src/index.ts',content:'fixture'});await $.tool.call({tool:'Write',file_path:'src/index.test.ts',content:'fixture'})
 const tree=await ui.find({type:'Box'})
 expect(tree).toBeDefined()
 console.log('MOD_PREVIEW:'+JSON.stringify({id:ID,tree}))
 await ui.unmount()
})
