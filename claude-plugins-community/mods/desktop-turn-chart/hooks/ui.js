// Pure presentation helpers, copied into each standalone plugin.
export function clean(v, n=9000) { return String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,'').slice(0,n) }
export function text(E,v,props={}) { return E.Text({...props,children:[clean(v)]}) }
export function code(E,v) { return E.Code({source:clean(v),language:'text'}) }
export function row(E,children) { return E.Box({flexDirection:'row',columnGap:2,flexWrap:'wrap',children}) }
export function frame(E,title,children) { return E.Box({flexDirection:'column',gap:1,children:[text(E,title,{bold:true,color:'cyan'}),...children]}) }
export function bounded(v,n=9000) { if(v.length>n)throw Error('Input exceeds '+n+' characters.');return v }
export function path(v) { v=v.trim();if(!v||v.startsWith('-')||/[\x00-\x1f]/.test(v))throw Error('Enter a path without control characters or leading flags.');return v }
export function xml(v) { return clean(v,200).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])) }
export function num(v) { return Number.isFinite(v)?v:0 }
export function pct(v) { return Math.max(0,Math.min(100,num(v))) }
export function count(v) { return Number.isFinite(v)?v.toLocaleString('en-US'):'not reported' }
export function waitUntil(v,now) { const n=Date.parse(v);if(!Number.isFinite(n))return 'reset not reported';const m=Math.max(0,Math.ceil((n-now)/60000));return m?Math.floor(m/60)+'h '+m%60+'m':'reset due; awaiting report' }
export function chart(E,values,labels,alt,scale) {
 const data=values.slice(-12), names=labels.slice(-12),max=scale||Math.max(1,...data.map(num)),h=40+data.length*30
 const rows=data.map((v,i)=>'<text x="12" y="'+(28+i*30)+'" fill="#d8dfeb" font-size="12">'+xml(names[i])+'</text><rect x="180" y="'+(12+i*30)+'" width="'+(Math.max(0,num(v))/max*310)+'" height="20" rx="5" fill="#8b9cf7"/><text x="505" y="'+(28+i*30)+'" fill="#d8dfeb" font-size="12">'+xml(Math.round(num(v)*10)/10)+'</text>').join('')
 return E.Svg({source:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 580 '+h+'" width="580" height="'+h+'"><rect width="580" height="'+h+'" rx="12" fill="#182234"/>'+rows+'</svg>',alt:clean(alt),height:h})
}
export function gauge(E,value,label) { return chart(E,[pct(value)],[label],label+': '+count(value)+'%',100) }
export function usageChips(u,records,now) {
 const totals=records.reduce((a,r)=>({input:a.input+num(r.input_tokens),output:a.output+num(r.output_tokens),cache:a.cache+num(r.cache_read_input_tokens)}),{input:0,output:0,cache:0})
 return [...u.rateLimits.slice(0,4).map(r=>r.kind+' '+count(r.percentUsed)+'% · '+waitUntil(r.resetsAt,now)),
  'Context '+count(u.context?.percent)+'%', 'Input '+count(totals.input),'Output '+count(totals.output),'Cache read '+count(totals.cache),'USD '+(Number.isFinite(u.cost?.usd)?u.cost.usd.toFixed(2):'not reported')]
}
export function strip(E,chips,columns) {
 const w=Math.min(1000,Math.max(240,(columns||80)*8)),colors=['#bbdbc6','#d4c8ed','#cbd5ed','#edcfbd','#bddec9','#ccd6f1','#e7d6a7']
 let x=4,y=4
 const pills=chips.map((s,i)=>{const cw=Math.min(w-8,s.length*6.5+24);if(x+cw>w){x=4;y+=40}const p='<rect x="'+x+'" y="'+y+'" width="'+cw+'" height="32" rx="16" fill="'+colors[i%colors.length]+'"/><text x="'+(x+12)+'" y="'+(y+21)+'" font-family="system-ui" font-size="12" fill="#202523">'+xml(s)+'</text>';x+=cw+8;return p}).join('')
 const h=y+36
 return E.Svg({source:'<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+pills+'</svg>',alt:chips.join('; '),height:h})
}
export function columns(E,e,children) { return E.Box({flexDirection:e.props.bodyColumns>=70?'row':'column',gap:2,children:children.map(c=>E.Box({flexDirection:'column',flexGrow:1,children:c}))}) }
