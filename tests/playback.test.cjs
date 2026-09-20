// Dependency-free event tests for playback state and timer boundaries.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function app() {
 class Element {
  constructor(){this.value='0';this.children=[];this.dataset={};this.listeners={};}
  addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
  emit(name){for(const fn of this.listeners[name]||[])fn({});}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(){this.children=[];}
  setAttribute(){}
  querySelector(){return null;}
 }
 class Audio extends Element {
  constructor(){super();this.paused=true;this.currentTime=0;this.duration=600;this.readyState=1;this.playbackRate=1;this.defaultPlaybackRate=1;}
  set src(value){this.sourceChanges=(this.sourceChanges||0)+1;this.source=value;this.currentTime=0;this.readyState=0;this.ended=false;this.playbackRate=this.defaultPlaybackRate;}
  play(){this.paused=false;this.emit('play');return Promise.resolve();}
  pause(){if(!this.paused){this.paused=true;this.emit('pause');}}
  metadata(){this.readyState=1;this.emit('loadedmetadata');}
 }
 const elements={},store={};let now=100000;
 const document={getElementById:id=>elements[id]||=(id==='audio'?new Audio():new Element()),createElement:()=>new Element(),addEventListener(){},activeElement:null};
 const context=vm.createContext({document,window:{addEventListener(){}},navigator:{},localStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>store[k]=v},setInterval(){},fetch:()=>new Promise(()=>{}),Date:class extends Date{static now(){return now;}},URL,console,MediaMetadata:class{},XMLHttpRequest:class{}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../script.js'),'utf8'),context);
 const run=s=>vm.runInContext(s,context);
 run("books=[{id:'one',title:'One',chapters:[{id:'a',title:'A',url:'/a'},{id:'b',title:'B',url:'/b'}]},{id:'two',title:'Two',chapters:[{id:'c',title:'C',url:'/c'}]}];selectBook(books[0],false);");
 elements.audio.metadata();
 return {elements,store,run,advance:ms=>now+=ms};
}
test('Each book retains its own position when switching',()=>{
 const a=app();a.elements.audio.currentTime=123;a.run('selectBook(books[1],false)');a.elements.audio.metadata();
 a.elements.audio.currentTime=45;a.run('selectBook(books[0],false)');a.elements.audio.metadata();
 assert.equal(a.elements.audio.currentTime,123);
 assert.equal(JSON.parse(a.store.playrecap_private_v1).progress.two.time,45);
});
test('Zero seeking is accepted and persists',()=>{
 const a=app();a.elements.audio.currentTime=120;a.run('seekTo(0)');
 assert.equal(a.elements.audio.currentTime,0);assert.equal(JSON.parse(a.store.playrecap_private_v1).progress.one.time,0);
});
test('A sleep deadline stops playback after a suspended timer and prevents auto-next',()=>{
 const a=app();a.run('play()');a.elements.timer.value='15';a.elements.timer.emit('change');a.advance(16*60000);
 a.elements.audio.emit('timeupdate');assert.equal(a.elements.audio.paused,true);assert.equal(a.elements.timer.value,'0');
 // Deadline also checked before auto-next when the last event is ended.
 a.elements.timer.value='15';a.elements.timer.emit('change');a.advance(16*60000);a.elements.audio.ended=true;a.elements.audio.emit('ended');
 assert.equal(a.elements.audio.source,'/a');
});
test('End-of-chapter stops while ordinary ended advances with the selected speed',()=>{
 const a=app();a.elements.timer.value='chapter';a.elements.timer.emit('change');a.elements.audio.ended=true;a.elements.audio.paused=true;a.elements.audio.emit('ended');
 assert.equal(a.elements.audio.source,'/a');assert.equal(a.elements.timer.value,'0');
 a.elements.speed.value='1.5';a.elements.speed.emit('change');a.elements.audio.emit('ended');a.elements.audio.metadata();
 assert.equal(a.elements.audio.source,'/b');assert.equal(a.elements.audio.playbackRate,1.5);assert.equal(a.elements.audio.paused,false);
});
test('A new chapter owns its zero position immediately, before metadata arrives',()=>{
 const a=app();a.elements.audio.currentTime=200;a.run('selectChapter(1,0,false)');
 const progress=JSON.parse(a.store.playrecap_private_v1).progress.one;
 assert.equal(progress.chapterId,'b');assert.equal(progress.time,0);
});

test('Tapping the playing chapter does not interrupt or reload its source',()=>{
 const a=app();a.run('play()');a.elements.audio.currentTime=123;
 const loads=a.elements.audio.sourceChanges;
 let pauses=0;a.elements.audio.addEventListener('pause',()=>pauses++);
 a.elements.chapters.children[0].children[0].emit('click');
 assert.equal(a.elements.audio.currentTime,123);
 assert.equal(a.elements.audio.sourceChanges,loads);
 assert.equal(a.elements.audio.paused,false);assert.equal(pauses,0);
});
test('Tapping the paused chapter resumes at the current position',()=>{
 const a=app();a.elements.audio.currentTime=87;const loads=a.elements.audio.sourceChanges;
 a.elements.chapters.children[0].children[0].emit('click');
 assert.equal(a.elements.audio.currentTime,87);assert.equal(a.elements.audio.paused,false);
 assert.equal(a.elements.audio.sourceChanges,loads);
});
test('Repeated taps while loading preserve the pending resume position',()=>{
 const a=app();a.run('selectChapter(1,72,true)');const loads=a.elements.audio.sourceChanges;
 a.elements.chapters.children[1].children[0].emit('click');
 a.elements.chapters.children[1].children[0].emit('click');
 assert.equal(a.elements.audio.sourceChanges,loads);
 a.elements.audio.metadata();assert.equal(a.elements.audio.currentTime,72);
});
test('Another chapter starts normally, and an errored current chapter can retry',()=>{
 const a=app();a.elements.audio.currentTime=87;
 a.elements.chapters.children[1].children[0].emit('click');a.elements.audio.metadata();
 assert.equal(a.elements.audio.source,'/b');assert.equal(a.elements.audio.currentTime,0);
 const loads=a.elements.audio.sourceChanges;a.elements.audio.error={code:2};
 a.elements.chapters.children[1].children[0].emit('click');
 assert.equal(a.elements.audio.sourceChanges,loads+1);
});
