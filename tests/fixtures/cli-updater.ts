import fs from 'node:fs/promises';
import path from 'node:path';

/** Every update writes only disposable fixture files. No real CLI or registry is used. */
export async function cliUpdateFixture(root: string) {
  const prefix = path.join(root, 'cli space'), pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code');
  const npm = path.join(prefix, 'node_modules', 'npm', 'bin'), config = path.join(root, 'claude-config');
  await Promise.all([fs.mkdir(pkg, { recursive: true }), fs.mkdir(npm, { recursive: true }), fs.mkdir(config, { recursive: true })]);
  const node = path.join(prefix, process.platform === 'win32' ? 'node.exe' : 'node');
  if (process.platform === 'win32') await fs.copyFile(process.execPath, node); else await fs.symlink(process.execPath, node);
  const version = path.join(root, 'version'), mode = path.join(root, 'mode'), log = path.join(root, 'commands.jsonl'), pids = path.join(root, 'pids');
  await Promise.all([fs.writeFile(version, '2.1.9'), fs.writeFile(mode, 'success'), fs.writeFile(log, ''), fs.writeFile(pids, ''),
    fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', bin: { claude: 'cli.js' } }))]);
  const constants = `const versionFile=${JSON.stringify(version)},modeFile=${JSON.stringify(mode)},logFile=${JSON.stringify(log)},pidsFile=${JSON.stringify(pids)};\n`;
  await fs.writeFile(path.join(npm, 'npm-cli.js'), constants + String.raw`
const fs=require('node:fs');
fs.appendFileSync(logFile,JSON.stringify({kind:'npm',args:process.argv.slice(2)})+'\n');
if(fs.readFileSync(modeFile,'utf8')==='offline'){console.error('https://secret:token@registry.invalid');process.exit(1);}
console.log(JSON.stringify('2.1.10'));
`);
  await fs.writeFile(path.join(pkg, 'cli.js'), constants + String.raw`
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const args=process.argv.slice(2), mode=fs.readFileSync(modeFile,'utf8');
if(args.includes('--version')){console.log(fs.readFileSync(versionFile,'utf8')+' (Claude Code)');process.exit(0);}
if(args.includes('--help')){console.log('--session-id --resume --permission-mode --model --effort --print --input-format --output-format --verbose --permission-prompt-tool --include-partial-messages');process.exit(0);}
if(args[0]==='update'){
  fs.appendFileSync(logFile,JSON.stringify({kind:'update',args,autoUpdater:process.env.DISABLE_AUTOUPDATER})+'\n');
  for(const pid of fs.readFileSync(pidsFile,'utf8').trim().split('\n').filter(Boolean).map(Number)){
    let alive=false;
    if(process.platform==='win32'){try{process.kill(pid,0);alive=true;}catch{}}
    else{try{alive=cp.execFileSync('ps',['-o','stat=','-p',String(pid)],{stdio:['ignore','pipe','ignore']}).toString().trim().split('\n').some(s=>s&&!s.trim().startsWith('Z'));}catch{}}
    if(alive){console.error('WORKSPACE PROCESS STILL ALIVE');process.exit(99);}
  }
  if(mode==='fail'){console.error('https://secret:token@registry.invalid');process.exit(1);}
  if(mode==='noop')process.exit(0);
  setTimeout(()=>{fs.writeFileSync(versionFile,'2.1.10');process.exit(0);},mode==='slow'?2500:800);return;
}
fs.appendFileSync(pidsFile,String(process.pid)+'\n');
fs.appendFileSync(logFile,JSON.stringify({kind:'session',autoUpdater:process.env.DISABLE_AUTOUPDATER})+'\n');
if(process.platform!=='win32'){
  const child=cp.spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
  fs.appendFileSync(pidsFile,String(child.pid)+'\n');
}
const flag=name=>args[args.indexOf(name)+1], session=args.includes('--resume')?flag('--resume'):flag('--session-id');
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const value=JSON.parse(line);
  if(value.type==='control_request'){output({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{commands:[]}}});return;}
  if(value.type==='user'){
    const dir=path.join(process.env.CLAUDE_CONFIG_DIR,'projects','fixture');fs.mkdirSync(dir,{recursive:true});
    fs.appendFileSync(path.join(dir,session+'.jsonl'),JSON.stringify({type:'user',sessionId:session,cwd:process.cwd(),message:value.message})+'\n');
    output({type:'system',subtype:'init',session_id:session,model:'fixture'});
  }
});
process.stdin.on('end',()=>process.exit(0));
`);
  const cli = path.join(prefix, 'claude.cmd');
  await fs.writeFile(cli, '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  await fs.writeFile(path.join(prefix, 'npm.cmd'), '@echo off\r\nexit /b 99\r\n', { mode: 0o755 });
  // POSIX npm uses the same standard script, while the fake CLI intentionally exercises CMD resolution.
  if (process.platform !== 'win32') await fs.writeFile(path.join(prefix, 'npm'), '#!/usr/bin/env node\n' + constants + await fs.readFile(path.join(npm, 'npm-cli.js'), 'utf8').then(text => text.slice(constants.length)), { mode: 0o755 });
  return { cli, version, mode, log, pids, config, prefix };
}
