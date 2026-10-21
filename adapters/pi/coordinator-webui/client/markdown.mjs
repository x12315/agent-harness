import { Lexer } from "./vendor/marked.mjs";

/** Mature Marked grammar rendered with DOM text nodes only: no raw HTML, automatic remote images or executable URLs. */
export function markdown(text) {
 const root=document.createElement('div');root.className='co-markdown';
 const append=(parent,tokens,depth=0)=>{
  if(depth>40)throw Error('Markdown nesting exceeds view budget');
  for(const token of tokens||[]){
   if(token.type==='space')continue;
   if(token.type==='code'){
    const block=document.createElement('div'),pre=document.createElement('pre'),code=document.createElement('code'),copy=document.createElement('button');
    block.className='co-code';code.textContent=token.text;copy.type='button';copy.textContent='复制代码';copy.setAttribute('aria-label','复制代码');
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(token.text);copy.textContent='已复制';}catch{copy.textContent='请选择代码手动复制';}});
    pre.append(code);block.append(copy,pre);parent.append(block);continue;
   }
   if(token.type==='list'){
    const list=document.createElement(token.ordered?'ol':'ul');if(token.ordered&&token.start>1)list.start=token.start;
    for(const item of token.items){const li=document.createElement('li');if(item.task)li.append(document.createTextNode(item.checked?'☑ ':'☐ '));append(li,item.tokens,depth+1);list.append(li);}parent.append(list);continue;
   }
   if(token.type==='table'){
    const table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr'),body=document.createElement('tbody');
    for(const cell of token.header){const th=document.createElement('th');append(th,cell.tokens,depth+1);row.append(th);}head.append(row);
    for(const cells of token.rows){const tr=document.createElement('tr');for(const cell of cells){const td=document.createElement('td');append(td,cell.tokens,depth+1);tr.append(td);}body.append(tr);}table.append(head,body);parent.append(table);continue;
   }
   const tag={paragraph:'p',heading:`h${Math.min(6,Math.max(1,token.depth||2))}`,strong:'strong',em:'em',del:'del',codespan:'code',blockquote:'blockquote',br:'br',hr:'hr',link:'a'}[token.type];
   if(!tag){if(token.tokens)append(parent,token.tokens,depth+1);else parent.append(document.createTextNode(token.type==='html'?token.raw:token.text||token.raw||''));continue;}
   const element=document.createElement(tag);
   if(token.type==='link'){
    try{const url=new URL(token.href,location.href);if(['http:','https:','mailto:'].includes(url.protocol)){element.href=url.href;element.rel='noopener noreferrer';element.target='_blank';}}catch{}
   }
   if(token.tokens)append(element,token.tokens,depth+1);else if(token.text)element.textContent=token.text;
   parent.append(element);
  }
 };
 try{append(root,Lexer.lex(String(text),{gfm:true}));}catch{root.replaceChildren(document.createTextNode(String(text)));}
 return root;
}
