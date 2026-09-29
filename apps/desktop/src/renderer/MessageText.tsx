import { Children, isValidElement, memo, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { MermaidBlock } from './MermaidBlock';

function plainText(node:ReactNode):string {
  return Children.toArray(node).map(child=>typeof child==='string'||typeof child==='number'?String(child):isValidElement<{children?:ReactNode}>(child)?plainText(child.props.children):'').join('');
}
function CodeBlock({children}:{children?:ReactNode}) {
  const [copied,setCopied]=useState(false),[failed,setFailed]=useState(false);
  const code=Children.toArray(children).find(child=>isValidElement(child));
  const language=isValidElement<{className?:string}>(code)?/language-([^\s]+)/.exec(code.props.className??'')?.[1]:undefined;
  const copy=async()=>{try{await window.desktop.copyText(plainText(children));setCopied(true);setFailed(false);}catch{setFailed(true);}};
  if(language?.toLowerCase()==='mermaid')return <MermaidBlock source={plainText(children)}/>;
  return <div className="message-code"><div className="message-code-heading"><span>{language??'代码'}</span><button className="text-button" aria-label="复制代码" onClick={()=>void copy()}>{copied?<Check size={13}/>:<Copy size={13}/>} {failed?'复制失败':copied?'已复制':'复制代码'}</button></div><pre>{children}</pre></div>;
}

/** CommonMark + GFM; raw HTML stays literal text and links retain the parser's safe URL policy. */
export const MessageText=memo(function MessageText({text}:{text:string}) {
  return <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight,{detect:false,ignoreMissing:true}]]} components={{pre:CodeBlock,a:({children,href,title})=><a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>,img:({alt})=><span className="markdown-image-label">[图片{alt?': '+alt:''}]</span>}}>{text}</ReactMarkdown></div>;
});
