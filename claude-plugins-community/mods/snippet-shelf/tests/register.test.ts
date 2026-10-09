import { expect, test } from 'claude-code/testing'
import { world, site } from './fixtures'
const ID="snippet-shelf"

test('registers an immediate command and opens only its pane', async ($, on) => {
 const {state}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 expect(state.registered.length).toBe(1)
 expect(state.registered[0].name).toBe(ID)
 expect(state.registered[0].immediate).toBe(true)
 expect(state.opened).toEqual([])
 await $.command.run({command:ID,args:''})
 expect(state.opened[0]).toMatchObject({id:ID,title:"Snippet Shelf",focus:true,closeOnEscape:true})
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
  expect(await ui.find({type:'Text',text:"Snippet Shelf"})).toBeDefined()
  expect(await ui.find({type:'Text',text:'Unable to inspect this data.'})).toBeUndefined()

await ui.input({key:'entry',text:"git log --oneline -10"})
expect(saved.size).toBe(1)
expect([...saved.keys()][0]).toContain('workspace:%2Fwork:item:')
await $.command.run({command:"snippet-shelf",args:''})
expect(saved.size).toBe(1)
await ui.press({key:'copy-0'});expect(state.copies).toEqual(["git log --oneline -10"])
await ui.press({key:'delete-0'});expect(saved.size).toBe(0)

  await ui.unmount()
 })
}


test('capture native render tree for fixture preview', async($,on)=>{
 const {state,saved,clock}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 await $.command.run({command:ID,args:''})
 const ui=await $.ui.mount(site(ID,'terminal',78))
 await ui.input({key:"entry",text:"git log --oneline -10"})
 const tree=await ui.find({type:'Box'})
 expect(tree).toBeDefined()
 console.log('MOD_PREVIEW:'+JSON.stringify({id:ID,tree}))
 await ui.unmount()
})
