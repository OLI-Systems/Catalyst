import { expect, test } from 'claude-code/testing'
import { world, site } from './fixtures'
const ID="stopwatch"

test('registers an immediate command and opens only its pane', async ($, on) => {
 const {state}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 expect(state.registered.length).toBe(1)
 expect(state.registered[0].name).toBe(ID)
 expect(state.registered[0].immediate).toBe(true)
 expect(state.opened).toEqual([])
 await $.command.run({command:ID,args:''})
 expect(state.opened[0]).toMatchObject({id:ID,title:"Stopwatch",focus:true,closeOnEscape:true})
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
  expect(await ui.find({type:'Text',text:"Stopwatch"})).toBeDefined()
  expect(await ui.find({type:'Text',text:'Unable to inspect this data.'})).toBeUndefined()

await ui.press({key:'start'});await clock.advance(2000)
await ui.press({key:'lap'})
expect(await ui.find({type:'Text',text:'Lap 1 · 2.0s'})).toBeDefined()
await ui.press({key:'start'});await clock.advance(1000)
expect(await ui.find({type:'Text',text:'2.0 seconds'})).toBeDefined()
await ui.press({key:'reset'})
expect(await ui.find({type:'Text',text:'0.0 seconds'})).toBeDefined()

  await ui.unmount()
 })
}


test('capture native render tree for fixture preview', async($,on)=>{
 const {state,saved,clock}=world(on)
 await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'})
 await $.command.run({command:ID,args:''})
 const ui=await $.ui.mount(site(ID,'terminal',78))
 await ui.press({key:'start'});await clock.advance(12400);await ui.press({key:'lap'});await clock.advance(4700);await ui.press({key:'start'})
 const tree=await ui.find({type:'Box'})
 expect(tree).toBeDefined()
 console.log('MOD_PREVIEW:'+JSON.stringify({id:ID,tree}))
 await ui.unmount()
})
