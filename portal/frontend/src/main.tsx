import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUp, Check, ChevronDown, Code2, Copy, Download, Gauge, KeyRound, LogOut,
  Menu, MessageSquarePlus, Moon, Paperclip, RotateCcw, Search, Sparkles, Square,
  Sun, Terminal, Trash2, Wrench, X, Zap, BrainCircuit, Bug, GitPullRequest,
  Blocks, BookOpenText, ShieldCheck, ExternalLink, CheckCircle2, Lock, TriangleAlert,
  Presentation, FileUp, LoaderCircle, Palette
} from 'lucide-react';
import 'highlight.js/styles/github-dark.css';
import './styles.css';

type User = { id:string; name:string; email:string };
type Conv = { id:string; title:string; mode:string; updated_at:string };
/** An image already sent. `url` is a data URL while the turn is live, and
 *  /api/images/:id once the conversation is reloaded from the server. */
type MsgImage = { name:string; url:string };
type Msg = { role:'user'|'assistant'; content:string; images?:MsgImage[] };
type Mode = 'auto'|'code'|'think'|'fast';
type Usage = { spend:number; maxBudget:number|null; budgetDuration:string|null; models:string[]; rpmLimit:number|null; tpmLimit:number|null };

// Two kinds, because the two travel differently: a text file is folded into the
// message the model reads, an image is sent beside it and makes the server route
// the question to the vision model rather than the mode the composer shows.
type Attachment =
  | { kind:'text'; name:string; size:number; content:string }
  | { kind:'image'; name:string; size:number; mime:string; data:string };

const MAX_ATTACHMENT_BYTES = 750_000;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_ATTACHMENTS = 4;
const IMAGE_MIME = ['image/png','image/jpeg','image/webp','image/gif'];
// Steers the file picker toward what the platform can read. It is a hint, not a
// guarantee — every picker offers an "all files" escape — so pickFiles checks
// each file as well.
const ATTACH_ACCEPT = [...IMAGE_MIME,'text/*','.js','.jsx','.ts','.tsx','.json','.md','.py','.java','.go','.rs','.rb','.php','.c','.h','.cpp','.cs','.css','.html','.sql','.sh','.yml','.yaml','.xml','.toml','.ini','.log','.csv'].join(',');
/** A NUL byte means a file read as text was never text: a PDF, an archive, a
 *  binary. Written as a pattern so no NUL has to sit in this source file. */
const BINARY_MARKER = /\u0000/;

/** Base64 payload of a file, without the `data:<mime>;base64,` prefix. */
function readBase64(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(reader.error);
    reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
    reader.readAsDataURL(file);
  });
}

const imageSrc=(a:Extract<Attachment,{kind:'image'}>)=>`data:${a.mime};base64,${a.data}`;

const MODES:{id:Mode; label:string; hint:string; icon:any}[] = [
  {id:'auto', label:'Auto', hint:'Best fit for the task', icon:Sparkles},
  {id:'code', label:'Code', hint:'Build, debug and review', icon:Code2},
  {id:'think', label:'Think', hint:'Architecture and deeper reasoning', icon:BrainCircuit},
  {id:'fast', label:'Fast', hint:'Quick answers and small tasks', icon:Zap}
];

/** The shortcut is Ctrl on Windows/Linux — showing ⌘ there is just wrong. */
const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(
  (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || ''
) ? '⌘K' : 'Ctrl K';

const QUICK = [
  {icon:Bug,title:'Fix a bug',desc:'Find the cause and verify the fix',text:'Help me debug this issue. Identify the likely root cause, propose the safest fix, and include concrete verification steps.'},
  {icon:GitPullRequest,title:'Review code',desc:'Check correctness, security and quality',text:'Review this code for correctness, security, performance and maintainability. Prioritize material issues and suggest focused improvements.'},
  {icon:Blocks,title:'Build a feature',desc:'Design it and implement it cleanly',text:'Help me design and implement this feature with production-ready code, clear assumptions, edge cases and verification steps.'},
  {icon:BookOpenText,title:'Explain code',desc:'Understand unfamiliar code quickly',text:'Explain what this code does in simple terms, then call out important dependencies, risks and opportunities to improve it.'}
];

/** An HTTP error that keeps the body with it. The sign-in form needs the rest
 *  of the payload - how many tries are left, when a lock lifts - and not only
 *  the sentence meant for display. */
class ApiError extends Error {
  status:number; payload:any;
  constructor(status:number, payload:any) {
    super(payload?.error || 'Request failed');
    this.status = status; this.payload = payload || {};
  }
}

async function api(path:string, options:RequestInit = {}) {
  const res = await fetch(path, {
    credentials:'include',
    ...options,
    headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

type StreamEvent = { event:string; data:any };

/**
 * Read an SSE response body and yield one decoded frame at a time.
 *
 * Frames are separated by a blank line, and a frame can straddle two network
 * reads, so whatever follows the last blank line is carried over to the next
 * chunk. Lines starting with `:` are heartbeat comments and carry no data.
 */
async function* readEvents(body:ReadableStream<Uint8Array>):AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for(;;){
    const {value,done} = await reader.read();
    if(done) break;
    buffer += decoder.decode(value,{stream:true});
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for(const frame of frames){
      let event = 'message'; let data = '';
      for(const line of frame.split(/\r?\n/)){
        if(line.startsWith('event:')) event = line.slice(6).trim();
        else if(line.startsWith('data:')) data += line.slice(5).trim();
      }
      if(!data) continue;
      try { yield {event, data: JSON.parse(data)}; } catch {}
    }
  }
}

function CopyButton({value,small=false}:{value:string;small?:boolean}) {
  const [done,setDone] = useState(false);
  return <button className={`icon-button ${small?'small':''}`} title="Copy" onClick={async()=>{
    await navigator.clipboard.writeText(value); setDone(true); setTimeout(()=>setDone(false),1200);
  }}>{done ? <Check size={14}/> : <Copy size={14}/>}</button>;
}

/** Flatten a rendered markdown node back to the source text inside it. */
function textOf(node:any):string{
  if(node==null||node===false||node===true) return '';
  if(typeof node==='string'||typeof node==='number') return String(node);
  if(Array.isArray(node)) return node.map(textOf).join('');
  if(node.props?.children!==undefined) return textOf(node.props.children);
  return '';
}

const CODE_EXTENSIONS:Record<string,string> = {
  javascript:'js', js:'js', jsx:'jsx', typescript:'ts', ts:'ts', tsx:'tsx',
  python:'py', py:'py', java:'java', go:'go', golang:'go', rust:'rs', rs:'rs',
  c:'c', cpp:'cpp', csharp:'cs', cs:'cs', php:'php', ruby:'rb', rb:'rb',
  bash:'sh', sh:'sh', shell:'sh', zsh:'sh', powershell:'ps1', sql:'sql',
  json:'json', yaml:'yml', yml:'yml', toml:'toml', xml:'xml', html:'html',
  css:'css', scss:'scss', markdown:'md', md:'md', dockerfile:'Dockerfile',
  ini:'ini', diff:'diff', env:'env'
};

/**
 * Save one code block to disk.
 *
 * Models routinely open a block with the path the code is meant to live at, so
 * that comment becomes the filename when it is there — saving four files out of
 * one answer should not produce four copies of `snippet.js`.
 */
function downloadCode(text:string, language:string){
  const declared = /^\s*(?:\/\/|#|--|<!--|\/\*)\s*([\w./-]+\.[A-Za-z0-9]{1,6})\b/.exec(text)?.[1];
  const name = declared?.split('/').pop() || `snippet.${CODE_EXTENSIONS[language.toLowerCase()] || 'txt'}`;
  const url = URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

/**
 * True while the answer being rendered is still arriving.
 *
 * The stream is re-parsed on every flush, so a fenced block spends most of its
 * life half-written - `flowchart TD` with two of its eventual nine edges. A
 * diagram drawn from that fails to parse on almost every frame, so code blocks
 * stay source until the answer is complete and draw once at the end.
 */
const StreamingAnswer = React.createContext(false);

/** The app's current theme, watched so a drawn diagram follows the toggle. */
function useThemeName(){
  const read = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const [theme,setTheme] = useState(read);
  useEffect(()=>{
    // The toggle keeps its state locally and writes the attribute. Watching the
    // attribute keeps diagrams in step without lifting that state into a store
    // and touching every component that reads it.
    const observer = new MutationObserver(()=>setTheme(read()));
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    return ()=>observer.disconnect();
  },[]);
  return theme;
}

let mermaidLoad:Promise<any>|null = null;
/**
 * Load mermaid once, on the first diagram anyone actually renders.
 *
 * It is by a wide margin the largest thing this app can pull in, and most
 * answers contain no diagram at all, so it is a dynamic import rather than a
 * top-level one: a developer who never asks for a flowchart never downloads it,
 * and the sign-in bundle is unchanged.
 */
function loadMermaid(){
  if(!mermaidLoad) mermaidLoad = import('mermaid').then(m=>m.default);
  return mermaidLoad;
}

/** Draw `code` as SVG, or report that it could not be drawn. Empty code is a no-op. */
function useMermaid(code:string){
  const theme = useThemeName();
  const [svg,setSvg] = useState('');
  const [failed,setFailed] = useState(false);
  useEffect(()=>{
    if(!code){ setSvg(''); setFailed(false); return; }
    let dead = false;
    loadMermaid().then(async (mermaid)=>{
      mermaid.initialize({
        startOnLoad:false,
        // Model output is not trusted input. `strict` blocks inline HTML in
        // labels and disables click bindings, so a diagram cannot carry script
        // into the page through an answer.
        securityLevel:'strict',
        theme: theme==='dark' ? 'dark' : 'default',
        fontFamily:'Inter, ui-sans-serif, system-ui, sans-serif'
      });
      // parse() before render(): render() appends its own error graphic to the
      // document when it throws, which would leave debris in the thread. parse
      // just tells us, so an undrawable block quietly stays code.
      await mermaid.parse(code);
      const { svg } = await mermaid.render('mermaid-'+Math.random().toString(36).slice(2,9), code);
      if(!dead){ setSvg(svg); setFailed(false); }
    }).catch(()=>{ if(!dead){ setSvg(''); setFailed(true); } });
    return ()=>{ dead = true; };
  },[code,theme]);
  return { svg, failed };
}

/**
 * Grammars, each behind its own dynamic import.
 *
 * The obvious route is rehype-highlight, but it does `import {common} from
 * 'lowlight'` at module scope and always references it, so every one of
 * lowlight's ~37 grammars lands in the entry bundle whether or not a
 * `languages` option is passed - measured here at more than the entire
 * application weighed before. Highlighting in the component instead means a
 * grammar is fetched the first time an answer actually contains that language,
 * and a developer who only ever sees Python never downloads Rust.
 */
const HIGHLIGHT_LOADERS:Record<string,()=>Promise<any>> = {
  javascript: ()=>import('highlight.js/lib/languages/javascript'),
  typescript: ()=>import('highlight.js/lib/languages/typescript'),
  python:     ()=>import('highlight.js/lib/languages/python'),
  java:       ()=>import('highlight.js/lib/languages/java'),
  go:         ()=>import('highlight.js/lib/languages/go'),
  rust:       ()=>import('highlight.js/lib/languages/rust'),
  c:          ()=>import('highlight.js/lib/languages/c'),
  cpp:        ()=>import('highlight.js/lib/languages/cpp'),
  csharp:     ()=>import('highlight.js/lib/languages/csharp'),
  php:        ()=>import('highlight.js/lib/languages/php'),
  ruby:       ()=>import('highlight.js/lib/languages/ruby'),
  sql:        ()=>import('highlight.js/lib/languages/sql'),
  bash:       ()=>import('highlight.js/lib/languages/bash'),
  json:       ()=>import('highlight.js/lib/languages/json'),
  yaml:       ()=>import('highlight.js/lib/languages/yaml'),
  xml:        ()=>import('highlight.js/lib/languages/xml'),
  css:        ()=>import('highlight.js/lib/languages/css'),
  markdown:   ()=>import('highlight.js/lib/languages/markdown'),
  dockerfile: ()=>import('highlight.js/lib/languages/dockerfile'),
  diff:       ()=>import('highlight.js/lib/languages/diff'),
  ini:        ()=>import('highlight.js/lib/languages/ini')
};

/** What models label blocks with, mapped to the grammar that handles it. */
const HIGHLIGHT_ALIASES:Record<string,string> = {
  js:'javascript', jsx:'javascript', mjs:'javascript', cjs:'javascript', node:'javascript',
  ts:'typescript', tsx:'typescript',
  py:'python', rb:'ruby', rs:'rust', 'c++':'cpp', cc:'cpp', h:'cpp', hpp:'cpp',
  cs:'csharp', golang:'go', sh:'bash', zsh:'bash', shell:'bash', console:'bash',
  yml:'yaml', html:'xml', svg:'xml', md:'markdown', toml:'ini', conf:'ini',
  docker:'dockerfile', patch:'diff', postgres:'sql', postgresql:'sql', mysql:'sql'
};

let hljsCore:Promise<any>|null = null;
const hljsRegistered = new Set<string>();

/** Highlighted HTML for `text`, or '' when the language is unknown or not yet loaded. */
function useHighlight(text:string, language:string){
  const [html,setHtml] = useState('');
  useEffect(()=>{
    const name = HIGHLIGHT_ALIASES[language] || language;
    const load = HIGHLIGHT_LOADERS[name];
    // No label, an unrecognised one, or nothing to colour: leave the block as
    // the plain <pre> it already renders as. Never guess the language - a
    // wrongly detected grammar colours the code as if it meant something else.
    if(!text || !load){ setHtml(''); return; }
    let dead = false;
    if(!hljsCore) hljsCore = import('highlight.js/lib/core').then(m=>m.default);
    Promise.all([hljsCore, load()]).then(([hljs,grammar])=>{
      if(!hljsRegistered.has(name)){
        hljs.registerLanguage(name, grammar.default);
        hljsRegistered.add(name);
      }
      // hljs escapes the source as it wraps it in spans, so the result is safe
      // to inject - it is the same output rehype-highlight would have produced.
      const out = hljs.highlight(text,{language:name}).value;
      if(!dead) setHtml(out);
    }).catch(()=>{ if(!dead) setHtml(''); });
    return ()=>{ dead = true; };
  },[text,language]);
  return html;
}

/**
 * A fenced code block, with its own copy and download controls.
 *
 * A ```mermaid block is drawn instead of printed, with a toggle back to the
 * source - the diagram is the answer, but the source is what a developer pastes
 * into their own docs. Anything that cannot be drawn falls back to being a
 * normal code block, which is what it was before diagrams existed.
 */
function CodeBlock({children,node,...rest}:any){
  const streaming = React.useContext(StreamingAnswer);
  const code = Array.isArray(children) ? children[0] : children;
  const language = /language-([\w+#-]+)/.exec(code?.props?.className || '')?.[1] || '';
  const text = textOf(code).replace(/\n$/,'');
  const [copied,setCopied] = useState(false);
  const [showSource,setShowSource] = useState(false);
  const isDiagram = language === 'mermaid';
  // Passing '' parks the hook without breaking the rule that hooks run
  // unconditionally, so a plain code block does nothing and loads nothing.
  const { svg, failed } = useMermaid(isDiagram && !streaming ? text : '');
  const drawn = isDiagram && !!svg && !failed;
  const highlighted = useHighlight(isDiagram ? '' : text, language);

  return <div className="code-block">
    <div className="code-bar">
      <span className="code-lang">{isDiagram ? (failed ? 'mermaid — could not be drawn' : 'diagram') : (language||'text')}</span>
      {drawn && <button onClick={()=>setShowSource(v=>!v)} title={showSource?'Show the diagram':'Show the mermaid source'}>
        <Code2 size={12}/>{showSource?'Diagram':'Source'}
      </button>}
      <button onClick={async()=>{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1200)}}>
        {copied?<Check size={12}/>:<Copy size={12}/>}{copied?'Copied':'Copy'}
      </button>
      <button onClick={()=>downloadCode(text,language)} title="Save this block as a file">
        <Download size={12}/>Download
      </button>
    </div>
    {drawn && !showSource
      ? <div className="mermaid-figure" dangerouslySetInnerHTML={{__html:svg}} />
      : highlighted
        ? <pre {...rest}><code className={`hljs language-${language}`} dangerouslySetInnerHTML={{__html:highlighted}} /></pre>
        : <pre {...rest}>{children}</pre>}
  </div>;
}

const MARKDOWN_COMPONENTS = { pre: CodeBlock };

/**
 * Maths support, fetched only for an answer that contains some.
 *
 * KaTeX and its stylesheet outweigh everything else the renderer needs put
 * together, and most engineering answers carry no formula at all, so they load
 * on sight of a `$$` rather than at sign-in. Until they arrive the block shows
 * as the literal text it is, then re-renders as maths.
 *
 * Only `$$...$$` counts. With single-dollar maths enabled, ordinary prose like
 * "$10 of credit raises it to 1000/day" parses as a formula and renders as
 * nonsense - and answers here discuss money far more often than algebra.
 */
function useMath(content:string){
  const wanted = content.includes('$$');
  const [plugins,setPlugins] = useState<any>(null);
  useEffect(()=>{
    if(!wanted || plugins) return;
    let dead = false;
    Promise.all([
      import('remark-math'),
      import('rehype-katex'),
      import('katex/dist/katex.min.css')
    ]).then(([math,katex])=>{
      if(!dead) setPlugins({ remark:[math.default,{singleDollarTextMath:false}], rehype:katex.default });
    }).catch(()=>{ /* formulas stay as written, which is still readable */ });
    return ()=>{ dead = true; };
  },[wanted,plugins]);
  return plugins;
}

/**
 * One assistant answer.
 *
 * Both the live stream and the stored message render through here, so a
 * diagram, a highlighted block and a formula look identical whether you watched
 * the answer arrive or reopened the conversation a week later.
 */
function Answer({content,streaming=false}:{content:string;streaming?:boolean}){
  const math = useMath(content);
  const remarkPlugins = useMemo(()=>math ? [remarkGfm, math.remark] : [remarkGfm], [math]);
  const rehypePlugins = useMemo(()=>math ? [math.rehype] : [], [math]);
  return <StreamingAnswer.Provider value={streaming}>
    <ReactMarkdown remarkPlugins={remarkPlugins as any} rehypePlugins={rehypePlugins as any} components={MARKDOWN_COMPONENTS}>
      {content}
    </ReactMarkdown>
  </StreamingAnswer.Provider>;
}

/** JSAN wordmark + product lockup. `invert` renders it white for blue panels. */
function Brand({compact=false, invert=false, size='md'}:{compact?:boolean; invert?:boolean; size?:'md'|'lg'}) {
  return <div className={`brand${compact?' compact':''}${invert?' brand-invert':''}${size==='lg'?' brand-lg':''}`}>
    <img className="brand-logo" src="/jsan-logo.png" alt="JSAN" />
    {!compact && <>
      <span className="brand-divider" aria-hidden="true" />
      <span className="brand-product">Dev AI</span>
    </>}
  </div>;
}

function ThemeButton(){
  const [dark,setDark]=useState(()=>localStorage.getItem('jsan-theme')==='dark');
  useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';localStorage.setItem('jsan-theme',dark?'dark':'light')},[dark]);
  return <button className="icon-button" title={dark?'Use light theme':'Use dark theme'} onClick={()=>setDark(v=>!v)}>{dark?<Sun size={15}/>:<Moon size={15}/>}</button>
}

type AlertTone = 'warn' | 'lock';
type AuthAlertState = { tone:AlertTone; title:string; body:string } | null;

/** mm:ss, for a lock the person is watching tick down. */
function clock(totalSeconds:number) {
  const m = Math.floor(totalSeconds / 60), s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

/**
 * The popup shown when a sign-in is refused.
 *
 * A wrong password used to arrive as a line of red text under the form, which
 * is easy to submit straight past - and past is the wrong direction when only
 * three tries exist. This interrupts instead, and says what the next mistake
 * costs.
 */
function AuthAlert({state,secondsLeft,onClose}:{state:AuthAlertState;secondsLeft:number;onClose:()=>void}) {
  useEffect(()=>{
    if(!state) return;
    const onKey = (e:KeyboardEvent)=>{ if(e.key==='Escape') onClose(); };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[state,onClose]);
  if(!state) return null;
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="auth-alert-title" onClick={e=>e.stopPropagation()}>
      <div className={`modal-icon ${state.tone}`}>{state.tone==='lock'?<Lock size={19}/>:<TriangleAlert size={19}/>}</div>
      <h3 id="auth-alert-title">{state.title}</h3>
      <p>{state.body}</p>
      {state.tone==='lock' && secondsLeft>0 &&
        <div className="modal-countdown"><span>Unlocks in</span><strong>{clock(secondsLeft)}</strong></div>}
      <button className="primary-button full" autoFocus onClick={onClose}>OK</button>
    </div>
  </div>;
}

function Auth({onReady}:{onReady:(u:User)=>void}) {
  const [tab,setTab] = useState<'login'|'register'>('login');
  const [form,setForm] = useState({name:'',email:'',password:'',confirmPassword:'',accessCode:''});
  const [status,setStatus] = useState<any>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [alert,setAlert] = useState<AuthAlertState>(null);
  // Epoch milliseconds at which the lock lifts, as the server reported it.
  const [lockedUntil,setLockedUntil] = useState<number|null>(null);
  const [tick,setTick] = useState(()=>Date.now());

  useEffect(()=>{ api('/api/auth/registration-status').then(setStatus).catch(()=>{}); },[]);

  // Only run a timer while something is actually counting down.
  useEffect(()=>{
    if(lockedUntil===null) return;
    const id = setInterval(()=>setTick(Date.now()),1000);
    return ()=>clearInterval(id);
  },[lockedUntil]);

  const secondsLeft = lockedUntil===null ? 0 : Math.max(0, Math.ceil((lockedUntil-tick)/1000));
  useEffect(()=>{ if(lockedUntil!==null && secondsLeft===0) setLockedUntil(null); },[lockedUntil,secondsLeft]);
  const locked = secondsLeft>0;

  const set = (patch:Partial<typeof form>)=>setForm(f=>({...f,...patch}));
  const mismatch = tab==='register' && form.confirmPassword.length>0 && form.password!==form.confirmPassword;

  const submit = async(e:React.FormEvent)=>{
    e.preventDefault();
    if(locked) return;
    // Caught here so the person is told without a round trip. The server checks
    // it again, because this form is not the only way to reach the route.
    if(tab==='register' && form.password!==form.confirmPassword){
      setAlert({tone:'warn',title:'Passwords do not match',body:'Type the same password into both fields, then try again.'});
      return;
    }
    setBusy(true); setError('');
    const body = tab==='login' ? { email:form.email, password:form.password } : form;
    try {
      const data = await api(`/api/auth/${tab}`,{method:'POST',body:JSON.stringify(body)});
      onReady(data.user);
    } catch(err:any) {
      const payload = err?.payload || {};
      if(err?.status===429 && payload.lockedUntil){
        setLockedUntil(new Date(payload.lockedUntil).getTime());
        setTick(Date.now());
        setForm(f=>({...f,password:'',confirmPassword:''}));
        setAlert({tone:'lock',title:'Account locked',body:payload.error});
      } else if(tab==='login' && err?.status===401){
        const left = payload.attemptsRemaining;
        setForm(f=>({...f,password:''}));
        setAlert({
          tone:'warn',
          title:'Incorrect email or password',
          body: typeof left==='number'
            ? `${left} ${left===1?'try':'tries'} left. After ${payload.maxAttempts ?? 3} wrong attempts this account is locked for ${payload.lockoutMinutes ?? 30} minutes.`
            : err.message
        });
      } else {
        setError(err?.message || 'Request failed');
      }
    } finally { setBusy(false); }
  };

  const canRegister = status?.registrationOpen !== false;
  const emailDomain = status?.emailDomain;
  const submitLabel = locked ? `Locked — ${clock(secondsLeft)}`
    : busy ? 'Please wait…'
    : tab==='login' ? 'Sign in' : 'Create account';

  return <div className="auth-screen">
    <div className="auth-glow glow-a"/><div className="auth-glow glow-b"/>
    <header className="auth-top"><Brand/><ThemeButton/></header>
    <main className="auth-main">
      <section className="auth-intro">
        <div className="auth-intro-brand"><Brand invert size="lg"/></div>
        <div className="auth-intro-body">
          <div className="product-chip"><Sparkles size={13}/> Built for engineering work</div>
          <h1>Move from question<br/>to working code faster.</h1>
          <p>A focused AI workspace for debugging, implementation, code review and architecture—available in the browser and your coding tools.</p>
          <div className="auth-proof">
            <div><CheckCircle2 size={16}/><span>One workspace</span></div>
            <div><CheckCircle2 size={16}/><span>One developer key</span></div>
            <div><CheckCircle2 size={16}/><span>Multiple AI providers</span></div>
          </div>
        </div>
        <p className="auth-intro-foot">JSAN Consulting — Global IT Partner</p>
      </section>
      <section className="auth-card">
        <div className="auth-card-head">
          <div><span className="eyebrow">JSAN Engineering</span><h2>{tab==='login' ? 'Welcome back' : 'Create your account'}</h2></div>
          {tab==='register'&&status&&<span className="seat-pill">{status.remaining} seats left</span>}
        </div>
        <p>{tab==='login' ? 'Continue where you left off.' : 'Use your work email and team access code.'}</p>
        <div className="auth-tabs">
          <button type="button" className={tab==='login'?'active':''} onClick={()=>{setTab('login');setError('')}}>Sign in</button>
          <button type="button" disabled={!canRegister} className={tab==='register'?'active':''} onClick={()=>{setTab('register');setError('')}}>Register</button>
        </div>
        <form onSubmit={submit}>
          {tab==='register' && <label>Username<input autoComplete="username" value={form.name} onChange={e=>set({name:e.target.value})} placeholder="The name your team will see" required/></label>}
          <label>Work email<input autoComplete="email" type="email" value={form.email} onChange={e=>set({email:e.target.value})} placeholder={`name@${emailDomain || 'yourcompany.com'}`} required/></label>
          <label>Password<input autoComplete={tab==='login'?'current-password':'new-password'} type="password" value={form.password} onChange={e=>set({password:e.target.value})} placeholder="At least 10 characters" required/></label>
          {tab==='register' && <label>Re-enter password
            <input autoComplete="new-password" type="password" className={mismatch?'mismatch':''} value={form.confirmPassword} onChange={e=>set({confirmPassword:e.target.value})} placeholder="Type the same password again" required/>
            {mismatch && <small className="field-hint">Both passwords must match.</small>}
          </label>}
          {tab==='register' && <label>Team access code<input value={form.accessCode} onChange={e=>set({accessCode:e.target.value})} placeholder="Code shared by your team" required/></label>}
          {error && <div className="form-error">{error}</div>}
          {locked && <div className="form-error">Locked after {status?.maxAttempts ?? 3} failed attempts. You can try again in {clock(secondsLeft)}.</div>}
          <button className="primary-button full" disabled={busy||locked||mismatch}>{submitLabel}</button>
        </form>
        <div className="auth-security"><ShieldCheck size={14}/><span>Provider credentials are never exposed to developer devices.</span></div>
      </section>
    </main>
    <AuthAlert state={alert} secondsLeft={secondsLeft} onClose={()=>setAlert(null)}/>
  </div>;
}
function App() {
  const [user,setUser] = useState<User|null>(null);
  const [loading,setLoading] = useState(true);
  const [page,setPage] = useState<'chat'|'slides'|'tools'|'usage'>('chat');
  const [mobileNav,setMobileNav] = useState(false);
  // Bumping this tells an already-mounted Chat to clear itself. It lives here
  // rather than in Chat because the shortcut and the button must work from
  // Tools and Usage too, where Chat is not mounted to hear a window event.
  const [newChatToken,setNewChatToken] = useState(0);
  useEffect(()=>{ api('/api/me').then(setUser).catch(()=>{}).finally(()=>setLoading(false)); },[]);

  const startNewChat = useCallback(()=>{
    setPage('chat');
    setMobileNav(false);
    setNewChatToken(t=>t+1);
  },[]);

  useEffect(()=>{
    const onKey=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); startNewChat(); }
    };
    window.addEventListener('keydown',onKey);
    return ()=>window.removeEventListener('keydown',onKey);
  },[startNewChat]);
  if(loading) return <div className="boot"><Brand/></div>;
  if(!user) return <Auth onReady={setUser}/>;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav?'show':''}`}>
      <div className="sidebar-top"><Brand/><button className="mobile-close icon-button" onClick={()=>setMobileNav(false)}><X size={17}/></button></div>
      <button className="new-chat" onClick={startNewChat}><MessageSquarePlus size={16}/><span>New chat</span><kbd>{SHORTCUT_LABEL}</kbd></button>
      <nav>
        <button className={page==='chat'?'active':''} onClick={()=>{setPage('chat');setMobileNav(false)}}><Sparkles size={16}/><span>Chat</span></button>
        <button className={page==='slides'?'active':''} onClick={()=>{setPage('slides');setMobileNav(false)}}><Presentation size={16}/><span>Slides</span></button>
        <button className={page==='tools'?'active':''} onClick={()=>{setPage('tools');setMobileNav(false)}}><Terminal size={16}/><span>Tools</span></button>
        <button className={page==='usage'?'active':''} onClick={()=>{setPage('usage');setMobileNav(false)}}><Gauge size={16}/><span>Usage</span></button>
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-foot">
        <div className="avatar">{user.name.split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase()}</div>
        <div className="who"><strong>{user.name}</strong><span>{user.email}</span></div>
        <ThemeButton/>
        <button className="icon-button" title="Sign out" onClick={async()=>{await api('/api/auth/logout',{method:'POST'});setUser(null)}}><LogOut size={15}/></button>
      </div>
    </aside>
    <main className="main-area">
      <button className="mobile-menu icon-button" onClick={()=>setMobileNav(true)}><Menu size={18}/></button>
      {/* Chat stays mounted so switching to Tools/Usage and back keeps the
          open conversation, the draft and the scroll position. */}
      <Chat newChatToken={newChatToken} hidden={page!=='chat'}/>
      {page==='slides' && <SlidesPage/>}
      {page==='tools' && <Tools/>}
      {page==='usage' && <UsagePage/>}
    </main>
  </div>;
}

function Chat({newChatToken=0, hidden=false}:{newChatToken?:number; hidden?:boolean}) {
  const [convs,setConvs] = useState<Conv[]>([]);
  const [active,setActive] = useState<string|null>(null);
  const [messages,setMessages] = useState<Msg[]>([]);
  const [mode,setMode] = useState<Mode>('auto');
  const [modeOpen,setModeOpen] = useState(false);
  const [input,setInput] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [historyOpen,setHistoryOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [attachments,setAttachments]=useState<Attachment[]>([]);
  // The answer currently arriving, and whether the model reasoned before it
  // started answering. Both are live-only and cleared when the turn ends. The
  // reasoning itself is never received, so nothing but the developer's own
  // message and the answer can appear in the thread.
  const [streamText,setStreamText] = useState('');
  const [thinking,setThinking] = useState(false);
  const [notice,setNotice] = useState('');
  const fileRef=useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  // Follow the incoming text only while the developer is already at the bottom,
  // so scrolling up to re-read something is not undone by the next token.
  const follow = useRef(true);
  // Bumped whenever the workspace is emptied or another conversation is opened.
  // A stream still running from the previous one keeps draining — the server
  // finishes and stores that answer where it belongs — but stops writing into
  // the workspace the developer has moved on to.
  const generation = useRef(0);
  // Lets the developer stop a long answer once they have read enough. The
  // server treats the closed connection as a stop and keeps what it sent.
  const abortRef = useRef<AbortController|null>(null);
  const refresh = ()=>api('/api/conversations').then(setConvs).catch(()=>{});
  // Load the list on mount and again each time the user comes back to Chat,
  // so anything started in another tab or on another machine shows up.
  useEffect(()=>{
    if(!hidden) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hidden]);
  // The composer starts one line tall and grows with what is typed. Without
  // this it stays fixed at one line and a multi-line prompt disappears behind
  // an internal scrollbar - you cannot see the second line of your own
  // question. Capped at the same 170px the stylesheet uses, after which it
  // scrolls. `* { box-sizing: border-box }` is what makes measuring against
  // scrollHeight stable rather than growing by the padding on every keystroke.
  useEffect(()=>{
    const ta=composerRef.current; if(!ta) return;
    ta.style.height='auto';
    ta.style.height=`${Math.min(ta.scrollHeight,170)}px`;
  },[input,attachments.length]);
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:'smooth'}); },[messages,busy]);
  // Streaming lands many times a second, so this one jumps rather than animates
  // — a smooth scroll restarting on every update never catches up.
  useEffect(()=>{ if(streamText && follow.current) endRef.current?.scrollIntoView({behavior:'auto'}); },[streamText]);
  // Clear the workspace whenever "New chat" is triggered, from any page.
  // Focusing the composer is what makes the click feel like it did something —
  // without it, pressing New chat on an already-empty chat looks like a no-op.
  // Skipped on the first run: the workspace is already empty at mount, and the
  // effect above has the list covered.
  const firstToken = useRef(true);
  useEffect(()=>{
    if(firstToken.current){ firstToken.current = false; return; }
    generation.current++;
    setActive(null); setMessages([]); setInput(''); setMode('auto'); setError(''); setAttachments([]);
    setStreamText(''); setThinking(false); setNotice(''); setBusy(false);
    if(!hidden) composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[newChatToken]);
  const load = async(id:string)=>{
    const d=await api(`/api/conversations/${id}`);
    generation.current++;
    setActive(id);
    setMessages(d.messages.map((m:any)=>({
      role:m.role,
      content:m.content,
      // The bytes stay on the server; only a reference comes back with the
      // conversation, so reopening one does not drag screenshots through JSON.
      images:(m.images||[]).map((i:any)=>({name:i.name,url:`/api/images/${i.id}`}))
    })));
    setMode((d.mode||'auto') as Mode);
    setHistoryOpen(false);
    setStreamText(''); setThinking(false); setNotice(''); setError(''); setBusy(false);
  };
  // Text files are folded into the message the model reads. Images cannot be:
  // they go alongside it, and the server routes the question to the vision
  // model. Everything that cannot be used is said out loud — the version before
  // this dropped an oversized file without a word and read a PNG as text.
  const pickFiles=async(files:FileList|null)=>{
    if(!files) return;
    const accepted:Attachment[]=[]; const refused:string[]=[];
    const mb=(n:number)=>`${(n/1e6).toFixed(n<1e6?2:1)} MB`;
    for(const f of Array.from(files)){
      if(f.type.startsWith('image/')){
        if(!IMAGE_MIME.includes(f.type)){ refused.push(`${f.name} — images must be PNG, JPEG, WebP or GIF`); continue; }
        if(f.size>MAX_IMAGE_BYTES){ refused.push(`${f.name} is ${mb(f.size)} — images are limited to ${mb(MAX_IMAGE_BYTES)}`); continue; }
        try { accepted.push({kind:'image',name:f.name,size:f.size,mime:f.type,data:await readBase64(f)}); }
        catch { refused.push(`${f.name} could not be read`); }
        continue;
      }
      if(f.size>MAX_ATTACHMENT_BYTES){ refused.push(`${f.name} is ${mb(f.size)} — text files are limited to ${mb(MAX_ATTACHMENT_BYTES)}`); continue; }
      let text:string;
      try { text=await f.text(); } catch { refused.push(`${f.name} could not be read`); continue; }
      if(BINARY_MARKER.test(text)){ refused.push(`${f.name} is neither text nor an image, so it cannot be read`); continue; }
      accepted.push({kind:'text',name:f.name,size:f.size,content:text});
    }
    const room=Math.max(0,MAX_ATTACHMENTS-attachments.length);
    if(accepted.length>room) refused.push(`only ${MAX_ATTACHMENTS} files can be attached at once`);
    setAttachments(a=>[...a,...accepted.slice(0,room)].slice(0,MAX_ATTACHMENTS));
    setNotice(refused.join(' · '));
    if(fileRef.current) fileRef.current.value='';
  };
  const send = async(text=input)=>{
    const base=text.trim(); if((!base&&!attachments.length)||busy)return;
    // Text files ride inside the message; images travel beside it, because the
    // model has to be handed them as image parts rather than as characters.
    const textFiles=attachments.filter(a=>a.kind==='text') as Extract<Attachment,{kind:'text'}>[];
    const imageFiles=attachments.filter(a=>a.kind==='image') as Extract<Attachment,{kind:'image'}>[];
    const attached=textFiles.map(a=>`\n\n--- Attached file: ${a.name} ---\n${a.content}\n--- End ${a.name} ---`).join('');
    // An image is already a question on its own, so it needs no stand-in text;
    // a text file sent without a question does.
    const message=(base||(textFiles.length?'Please review the attached file(s).':''))+attached;
    const display=base+(textFiles.length?`\n\n${textFiles.map(a=>`📎 ${a.name}`).join('\n')}`:'');
    const shown=imageFiles.map(a=>({name:a.name,url:imageSrc(a)}));
    // Held so a failed turn can put the developer back exactly where they were,
    // attachments included, instead of making them pick the files again.
    const sent=attachments;
    const myGeneration=generation.current;
    const stale=()=>generation.current!==myGeneration;
    setInput(''); setAttachments([]); setError(''); setNotice(''); setThinking(false); setStreamText('');
    setBusy(true); follow.current=true; setMessages(m=>[...m,{role:'user',content:display,images:shown}]);
    // Tokens are accumulated here and pushed into React on a timer rather than
    // on arrival: every update re-renders the whole markdown tree, and ~16
    // frames a second reads as continuous without making the tab stutter.
    let answer=''; let lastFlush=0;
    const flush=()=>{ const now=Date.now(); if(now-lastFlush<60) return; lastFlush=now; setStreamText(answer); };
    const controller=new AbortController(); abortRef.current=controller;
    try{
      const res=await fetch('/api/chat',{
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message,mode,conversationId:active,images:imageFiles.map(a=>({name:a.name,mime:a.mime,data:a.data}))}),
        signal:controller.signal
      });
      // Anything rejected before the stream opens still answers as plain JSON.
      if(!res.ok||!res.body){ const d=await res.json().catch(()=>({})); throw new Error(d.error||'Request failed'); }
      let finished=false;
      for await (const {event,data} of readEvents(res.body)){
        // Keep reading after a reset so the server is never left writing into a
        // socket nobody drains; just stop applying anything to the workspace.
        if(stale()) continue;
        if(event==='start') setActive(data.conversationId);
        else if(event==='thinking') setThinking(true);
        else if(event==='delta'){ answer+=String(data.text||''); flush(); }
        else if(event==='error') throw new Error(data.error||'AI is unavailable right now. Try again shortly.');
        else if(event==='done'){
          finished=true;
          // Committing the message and dropping the live buffer together keeps
          // the answer from appearing twice for a frame.
          setMessages(m=>[...m,{role:'assistant',content:answer}]); setStreamText(''); setThinking(false);
          if(data.truncated) setNotice('That answer reached its length limit and stops early. Ask for the rest, or narrow the request.');
        }
      }
      if(stale()){ refresh(); return; }
      if(!finished) throw new Error('The connection dropped before the answer finished.');
      refresh();
    }
    catch(e:any){
      if(stale()) return;
      // Stopping on purpose is not a failure: whatever arrived is the answer,
      // and the server has already stored the same partial text.
      if(e?.name==='AbortError' && answer.trim()){ setMessages(m=>[...m,{role:'assistant',content:answer}]); refresh(); }
      else { setMessages(m=>m.slice(0,-1)); setInput(base); setAttachments(sent); if(e?.name!=='AbortError') setError(e.message); refresh(); }
    }
    finally { abortRef.current=null; setBusy(false); setStreamText(''); setThinking(false) }
  };
  const del = async(e:React.MouseEvent,id:string)=>{e.stopPropagation();await api(`/api/conversations/${id}`,{method:'DELETE'});if(active===id){setActive(null);setMessages([])}refresh()};
  const currentMode=MODES.find(m=>m.id===mode)!; const ModeIcon=currentMode.icon;
  const filtered=convs.filter(c=>c.title.toLowerCase().includes(search.toLowerCase()));
  return <div className={`chat-layout${hidden?' is-hidden':''}`}>
    <aside className={`history ${historyOpen?'show':''}`}>
      <div className="history-head"><span>Conversations</span><button className="mobile-close icon-button" onClick={()=>setHistoryOpen(false)}><X size={15}/></button></div>
      <div className="history-search"><Search size={13}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search"/></div>
      <div className="history-list">{filtered.length===0?<div className="history-empty">{convs.length?'No matches yet.':'Your recent work will appear here.'}</div>:filtered.map(c=><button key={c.id} className={`history-item ${active===c.id?'active':''}`} onClick={()=>load(c.id)}><span>{c.title}</span><Trash2 onClick={e=>del(e,c.id)} size={13}/></button>)}</div>
    </aside>
    <section className="workspace">
      <header className="workspace-header">
        <div className="workspace-left"><button className="history-toggle icon-button" onClick={()=>setHistoryOpen(true)}><Menu size={15}/></button><div className="status-dot"/><strong>{active?'Conversation':'New chat'}</strong></div>
        <div className="mode-select">
          <button onClick={()=>setModeOpen(v=>!v)}><ModeIcon size={14}/>{currentMode.label}<ChevronDown size={14}/></button>
          {modeOpen&&<div className="mode-menu">{MODES.map(m=>{const I=m.icon;return <button key={m.id} className={m.id===mode?'selected':''} onClick={()=>{setMode(m.id);setModeOpen(false)}}><I size={15}/><div><strong>{m.label}</strong><span>{m.hint}</span></div>{m.id===mode&&<Check size={14}/>}</button>})}</div>}
        </div>
      </header>
      <div className="thread" ref={threadRef} onScroll={()=>{const el=threadRef.current; follow.current = !el || el.scrollHeight-el.scrollTop-el.clientHeight < 120;}}>
        {messages.length===0 ? <div className="empty-state">
          <div className="hero-kicker"><span className="pulse-dot"/> Ready to work</div>
          <h1>What are you building?</h1>
          <p>Bring a bug, a feature, a codebase question or an architecture decision.</p>
          <div className="quick-grid">{QUICK.map(q=>{const I=q.icon;return <button key={q.title} onClick={()=>{setInput(q.text);setTimeout(()=>document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(),0)}}><div className="quick-icon"><I size={16}/></div><div><strong>{q.title}</strong><span>{q.desc}</span></div><ArrowUp size={14}/></button>})}</div>
          <div className="starter-note"><ShieldCheck size={14}/><span>Use approved work content only. Review generated code before merging.</span></div>
        </div> : messages.map((m,i)=>m.role==='user'
          ? <div className="user-message" key={i}><div>
              {m.images?.length ? <div className="message-images">{m.images.map((img,j)=><img key={j} src={img.url} alt={img.name} title={img.name}/>)}</div> : null}
              {m.content}
            </div></div>
          : <div className="assistant-message" key={i}><div className="assistant-icon"><Sparkles size={14}/></div><div className="markdown"><Answer content={m.content}/><button className="copy-answer" onClick={()=>navigator.clipboard.writeText(m.content)}><Copy size={12}/>Copy response</button></div></div>)}
        {busy&&<div className="assistant-message"><div className="assistant-icon"><Sparkles size={14}/></div>
          {streamText
            ? <div className="markdown"><Answer content={streamText} streaming/><span className="stream-caret"/></div>
            : <div className="thinking"><span>{thinking?'Thinking':'Working'}</span><i/><i/><i/></div>}
        </div>}
        {notice&&<div className="chat-notice">{notice}</div>}
        {error&&<div className="chat-error">{error}</div>}
        <div ref={endRef}/>
      </div>
      <footer className="composer-area">
        <div className="composer">
          {attachments.length>0&&<div className="attachments">{attachments.map((a,i)=><span key={a.name+i}>
            {a.kind==='image' ? <img className="chip-thumb" src={imageSrc(a)} alt=""/> : <Code2 size={12}/>}
            {a.name}
            <button onClick={()=>setAttachments(x=>x.filter((_,j)=>j!==i))}><X size={11}/></button>
          </span>)}</div>}
          <textarea ref={composerRef} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}}} placeholder="Ask about code, bugs, architecture or implementation…" rows={1}/>
          <div className="composer-foot"><div className="composer-actions"><input ref={fileRef} type="file" accept={ATTACH_ACCEPT} multiple hidden onChange={e=>pickFiles(e.target.files)}/><button className="composer-tool" title="Attach code, text or a screenshot" onClick={()=>fileRef.current?.click()}><Paperclip size={14}/><span>Attach</span></button><span className="mode-label"><ModeIcon size={12}/>{currentMode.label}</span></div><div className="send-side"><span>{busy?'Streaming':'Enter to send'}</span>{busy
              ? <button className="send-button stop" title="Stop generating" onClick={()=>abortRef.current?.abort()}><Square size={12}/></button>
              : <button className="send-button" disabled={!input.trim()&&!attachments.length} onClick={()=>send()}><ArrowUp size={16}/></button>}</div></div>
        </div>
      </footer>
    </section>
  </div>;
}

function Tools() {
  const [key,setKey] = useState(''); const [cfg,setCfg] = useState<any>(null); const [show,setShow] = useState(false); const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  useEffect(()=>{Promise.all([api('/api/me/api-key'),api('/api/tools/config')]).then(([k,c])=>{setKey(k.apiKey);setCfg(c)}).catch(e=>setError(e.message))},[]);
  const rotate=async()=>{if(!confirm('Rotate your developer key? Tools using the old key will stop working.'))return;setBusy(true);setError('');try{const d=await api('/api/me/api-key/rotate',{method:'POST'});setKey(d.apiKey)}catch(e:any){setError(e.message)}finally{setBusy(false)}};
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Developer tools</span><h1>Take the same AI into your editor.</h1><p>Use one JSAN endpoint and your personal key across supported coding tools.</p></div><div className="header-badge"><span/><strong>Gateway ready</strong></div></header>
    {error&&<div className="page-error">{error}</div>}
    <div className="content-grid">
      <section className="card span-2 key-card"><div className="card-head"><div><div className="card-icon"><KeyRound size={17}/></div><div><h2>Your developer key</h2><p>Use it in your own tools. Keep it private.</p></div></div><button className="secondary-button" onClick={rotate} disabled={busy}><RotateCcw size={14}/>{busy?'Rotating…':'Rotate key'}</button></div><div className="key-box"><code>{show?key:key?`${key.slice(0,8)}${'•'.repeat(30)}${key.slice(-5)}`:'Loading…'}</code><button className="text-button" onClick={()=>setShow(v=>!v)}>{show?'Hide':'Show'}</button><CopyButton value={key}/></div></section>
      <ToolCard icon={<Code2 size={17}/>} title="Codex CLI" text="Use Code mode through the JSAN gateway." value={cfg?.codex||''} note="Set JSAN_AI_KEY to your developer key."/>
      <ToolCard icon={<Sparkles size={17}/>} title="Claude Code" text="Route Claude Code through the same gateway." value={cfg?.claude||''} note="Use your developer key as the Anthropic auth token."/>
      <ToolCard icon={<Terminal size={17}/>} title="OpenAI-compatible tools" text="For IDEs, SDKs and local scripts." value={cfg?.env||''} note={`Base URL: ${cfg?.baseUrl||'—'}`}/>
      <ToolCard icon={<Wrench size={17}/>} title="Connection check" text="Confirm your endpoint and key in one command." value={cfg?.curl||''} note="A model list means the connection is working."/>
      <section className="card span-2 tool-help"><div><h2>Recommended setup</h2><p>Use the browser for discussion and quick reviews. Use Codex or Claude Code when you want AI working directly with a repository.</p></div><a href="https://ai.jsanconsulting.com/v1" target="_blank" rel="noreferrer">API endpoint <ExternalLink size={13}/></a></section>
    </div>
  </div>;
}

function ToolCard({icon,title,text,value,note}:{icon:any;title:string;text:string;value:string;note:string}){return <section className="card"><div className="card-head simple"><div><div className="card-icon">{icon}</div><div><h2>{title}</h2><p>{text}</p></div></div></div><Snippet value={value}/><p className="card-note">{note}</p></section>}
function Snippet({value}:{value:string}) { return <div className="snippet"><pre>{value||'Loading…'}</pre><CopyButton value={value}/></div> }

type DeckTemplate = { id:string; label:string; description:string; swatch:string[] };
type DeckResult = {
  file:{ filename:string; base64:string; bytes:number; contentType:string };
  deck:{ title:string; subtitle:string; slideCount:number; slideTitles:string[]; organisedBy:string; template:string };
  source:{ pages:number; pageCount:number; headings:number; tablesCarried:number; tablesFound:number; imagesCarried:number; imagesFound:number };
  warnings:string[];
};

const CONVERT_STEPS = [
  {key:'extracting', label:'Reading the PDF'},
  {key:'planning',   label:'Organising slides'},
  {key:'building',   label:'Building the file'},
  {key:'done',       label:'Ready to download'}
];

/** Decode without spreading: a multi-megabyte deck would blow the call stack. */
function base64ToBytes(base64:string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function SlidesPage() {
  const [templates,setTemplates] = useState<DeckTemplate[]>([]);
  const [template,setTemplate] = useState('');
  const [limits,setLimits] = useState({maxPdfBytes:8*1024*1024, maxPages:60});
  const [file,setFile] = useState<File|null>(null);
  const [useAi,setUseAi] = useState(true);
  const [stage,setStage] = useState('idle');
  const [note,setNote] = useState('');
  const [error,setError] = useState('');
  const [result,setResult] = useState<DeckResult|null>(null);
  const [dragging,setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(()=>{
    api('/api/documents/templates')
      .then(d=>{ setTemplates(d.templates); setTemplate(t=>t||d.defaultTemplate); setLimits({maxPdfBytes:d.maxPdfBytes, maxPages:d.maxPages}); })
      .catch(e=>setError(e.message));
  },[]);

  const busy = stage!=='idle' && stage!=='done' && stage!=='failed';
  const maxMb = Math.round(limits.maxPdfBytes/1024/1024);

  // Everything is checked before upload too, so an obvious mistake costs no round trip.
  const choose = (picked?:File|null) => {
    setError(''); setResult(null); setStage('idle'); setNote('');
    if (!picked) return;
    if (!(picked.type === 'application/pdf' || /\.pdf$/i.test(picked.name))) {
      setError(`${picked.name} is not a PDF. Choose a file that ends in .pdf.`); return;
    }
    if (!picked.size) { setError(`${picked.name} is empty.`); return; }
    if (picked.size > limits.maxPdfBytes) {
      setError(`${picked.name} is ${(picked.size/1024/1024).toFixed(1)} MB. The limit is ${maxMb} MB.`); return;
    }
    setFile(picked);
  };

  const convert = async () => {
    if (!file || busy) return;
    setError(''); setResult(null); setStage('extracting'); setNote('Reading the PDF');
    try {
      const dataUrl = await new Promise<string>((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(String(reader.result));
        reader.onerror = ()=>reject(new Error('That file could not be read from disk.'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/documents/pdf-to-pptx', {
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          filename:file.name,
          pdfBase64: dataUrl.slice(dataUrl.indexOf(',')+1),
          theme:template,
          useAi
        })
      });
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(()=>({}));
        throw new Error(detail.error || `The conversion failed (${res.status}).`);
      }

      // Progress is streamed as newline-delimited JSON while the work happens,
      // so the steps below reflect the server rather than a timer.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished:DeckResult|null = null;
      for(;;){
        const {value,done} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value,{stream:true});
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.stage === 'failed') throw new Error(event.error || 'The conversion failed.');
          if (event.message) setNote(event.message);
          if (event.stage === 'done') { finished = event as DeckResult; setStage('done'); }
          else setStage(event.stage === 'extracted' ? 'planning' : event.stage);
        }
      }
      if (!finished) throw new Error('The conversion ended before a file was produced.');
      setResult(finished);
      setNote('');
    } catch(e:any) {
      setStage('failed'); setNote(''); setError(e.message);
    }
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([base64ToBytes(result.file.base64)], {type:result.file.contentType});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = result.file.filename;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  };

  const stepIndex = CONVERT_STEPS.findIndex(s=>s.key===stage);
  const allDone = stage==='done';

  return <div className="page">
    <header className="page-header">
      <div>
        <span className="eyebrow">Documents</span>
        <h1>Turn a PDF into editable slides.</h1>
        <p>Headings, bullets, tables and figures come across as real PowerPoint content you can edit.</p>
      </div>
      <div className="header-badge"><span/><strong>PPTX</strong></div>
    </header>

    {error && <div className="page-error">{error}</div>}

    <div className="content-grid">
      <section className="card span-2">
        <div className="card-head simple"><div>
          <div className="card-icon"><FileUp size={17}/></div>
          <div><h2>1 — Choose a PDF</h2><p>Up to {maxMb} MB and {limits.maxPages} pages. The text has to be selectable — a scan needs OCR first.</p></div>
        </div></div>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden onChange={e=>choose(e.target.files?.[0])}/>
        {!file
          ? <button
              className={`dropzone${dragging?' is-dragging':''}`}
              onClick={()=>inputRef.current?.click()}
              onDragOver={e=>{e.preventDefault(); setDragging(true)}}
              onDragLeave={()=>setDragging(false)}
              onDrop={e=>{e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0])}}>
              <FileUp size={20}/>
              <strong>Drop a PDF here, or click to choose</strong>
              <span>Processed on the server and not stored afterwards.</span>
            </button>
          : <div className="chosen-file">
              <span className="chosen-icon"><Presentation size={15}/></span>
              <span className="chosen-meta"><strong>{file.name}</strong><span>{(file.size/1024).toFixed(0)} KB</span></span>
              <button className="icon-button" title="Remove this file" disabled={busy}
                onClick={()=>{setFile(null); setResult(null); setStage('idle'); setError(''); setNote('')}}><X size={15}/></button>
            </div>}
      </section>

      <section className="card">
        <div className="card-head simple"><div>
          <div className="card-icon"><Palette size={17}/></div>
          <div><h2>2 — Template</h2><p>Applied to every generated slide.</p></div>
        </div></div>
        <div className="template-grid">
          {templates.length===0
            ? <span className="convert-hint">Loading templates…</span>
            : templates.map(t=>(
                <button key={t.id} disabled={busy}
                  className={`template-option${template===t.id?' selected':''}`}
                  onClick={()=>setTemplate(t.id)}>
                  <span className="swatch">{t.swatch.map((c,i)=><i key={i} style={{background:c}}/>)}</span>
                  <span className="template-meta"><strong>{t.label}</strong><span>{t.description}</span></span>
                  {template===t.id && <Check size={13}/>}
                </button>
              ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head simple"><div>
          <div className="card-icon"><Sparkles size={17}/></div>
          <div><h2>3 — Structure</h2><p>How the deck gets organised.</p></div>
        </div></div>
        <label className="switch-row">
          <input type="checkbox" checked={useAi} disabled={busy} onChange={e=>setUseAi(e.target.checked)}/>
          <span className="switch" aria-hidden="true"/>
          <span className="switch-text">
            <strong>Use AI to organise the deck</strong>
            <span>It groups and titles the slides. Tables and figures are copied from the PDF either way, never rewritten, so no figure can be invented.</span>
          </span>
        </label>
        {!useAi && <p className="convert-hint">Slides will follow the PDF's own heading structure.</p>}
      </section>

      <section className="card span-2">
        <div className="convert-row">
          <button className="primary-button" disabled={!file||busy} onClick={convert}>
            {busy ? <><LoaderCircle size={14} className="spin"/>Converting…</> : <><Presentation size={14}/>Convert to PowerPoint</>}
          </button>
          {!file && stage==='idle' && <span className="convert-hint">Choose a PDF to begin.</span>}
          {note && <span className="convert-hint">{note}…</span>}
        </div>
        {(busy || allDone) && <ol className="stepper">
          {CONVERT_STEPS.map((step,i)=>{
            const done = allDone || stepIndex>i;
            return <li key={step.key} className={done?'is-done':stepIndex===i?'is-active':''}>
              <span className="step-dot">{done ? <Check size={11}/> : stepIndex===i ? <LoaderCircle size={11} className="spin"/> : i+1}</span>
              <span>{step.label}</span>
            </li>;
          })}
        </ol>}
      </section>

      {result && <section className="card span-2 deck-result">
        <div className="card-head">
          <div>
            <div className="card-icon"><Presentation size={17}/></div>
            <div>
              <h2>{result.deck.title}</h2>
              <p>{result.deck.slideCount} slides · {(result.file.bytes/1024).toFixed(0)} KB · organised by {result.deck.organisedBy==='ai'?'AI':'document structure'}</p>
            </div>
          </div>
          <button className="primary-button" onClick={download}><Download size={14}/>Download PPTX</button>
        </div>
        <div className="deck-stats">
          <div><strong>{result.source.pages}</strong><span>pages read{result.source.pageCount>result.source.pages?` of ${result.source.pageCount}`:''}</span></div>
          <div><strong>{result.source.headings}</strong><span>headings found</span></div>
          <div><strong>{result.source.tablesCarried}/{result.source.tablesFound}</strong><span>tables carried</span></div>
          <div><strong>{result.source.imagesCarried}/{result.source.imagesFound}</strong><span>figures carried</span></div>
        </div>
        {result.deck.slideTitles.length>0 && <div className="slide-list">
          {result.deck.slideTitles.map((title,i)=><span key={i}><b>{i+2}</b>{title}</span>)}
        </div>}
        {result.warnings.length>0 && <div className="deck-warnings">
          <TriangleAlert size={13}/>
          <div>{result.warnings.map((w,i)=><p key={i}>{w}</p>)}</div>
        </div>}
      </section>}
    </div>
  </div>;
}

function UsagePage() {
  const [data,setData] = useState<Usage|null>(null); const [error,setError] = useState('');
  useEffect(()=>{api('/api/usage/me').then(setData).catch(e=>setError(e.message))},[]);
  const pct = useMemo(()=>data?.maxBudget ? Math.min(100,(data.spend/data.maxBudget)*100) : 0,[data]);
  return <div className="page">
    <header className="page-header"><div><span className="eyebrow">Usage</span><h1>Simple visibility, no guesswork.</h1><p>See the access attached to your developer key without worrying about provider-level details.</p></div></header>
    {error&&<div className="page-error">{error}</div>}
    {!data?<div className="skeleton"/>:<div className="content-grid">
      <section className="metric-card"><span>Current spend</span><strong>${data.spend.toFixed(2)}</strong><small>{data.budgetDuration?'Current budget period':'Tracked by the gateway'}</small></section>
      <section className="metric-card"><span>Personal budget</span><strong>{data.maxBudget==null?'Flexible':`$${data.maxBudget.toFixed(2)}`}</strong><small>{data.maxBudget==null?'No personal cap configured':`${Math.max(0,100-pct).toFixed(0)}% remaining`}</small></section>
      <section className="metric-card"><span>Work modes</span><strong>{data.models.length}</strong><small>Auto · Code · Think · Fast</small></section>
      <section className="metric-card"><span>Access</span><strong>{data.rpmLimit||'Managed'}</strong><small>{data.rpmLimit?'Requests per minute':'Handled centrally'}</small></section>
      {data.maxBudget!=null&&<section className="card span-2"><div className="budget-line"><div><h2>Budget use</h2><p>${data.spend.toFixed(2)} of ${data.maxBudget.toFixed(2)}</p></div><strong>{pct.toFixed(0)}%</strong></div><div className="progress"><span style={{width:`${pct}%`}}/></div></section>}
      <section className="card span-2 mode-guide"><div><span className="mode-symbol auto"><Sparkles size={16}/></span><strong>Auto</strong><p>Default for everyday work.</p></div><div><span className="mode-symbol code"><Code2 size={16}/></span><strong>Code</strong><p>Implementation and debugging.</p></div><div><span className="mode-symbol think"><BrainCircuit size={16}/></span><strong>Think</strong><p>Architecture and complex reasoning.</p></div><div><span className="mode-symbol fast"><Zap size={16}/></span><strong>Fast</strong><p>Quick questions and small tasks.</p></div></section>
    </div>}
  </div>;
}

// Guarded rather than asserted so this module can be imported by a render
// harness that mounts one component on its own page. In the app itself #root
// always exists, so this is the same behaviour with one fewer way to crash.
const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(<App/>);

export { Answer };
