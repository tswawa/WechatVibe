const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { attachAdvisorCompanion, companionBounds, WIDTH } = require('../scripts/advisor-companion.cjs');
function fixture() {
  const views=[], handlers=new Map(), ipcMain=new EventEmitter(), copied=[];
  ipcMain.handle=(name,fn)=>handlers.set(name,fn); ipcMain.removeHandler=name=>handlers.delete(name);
  function contents() {
    const wc=new EventEmitter(); wc.mainFrame={url:'http://127.0.0.1:45678/'}; wc.sent=[]; wc.destroyed=false; wc.focused=false;
    wc.send=(name,value)=>wc.sent.push({name,value}); wc.setWindowOpenHandler=()=>{};
    wc.loadURL=url=>{wc.mainFrame.url=url;return Promise.resolve();};
    wc.isDestroyed=()=>wc.destroyed; wc.isFocused=()=>wc.focused; wc.focus=()=>{wc.focused=true;}; wc.close=()=>{wc.destroyed=true;};return wc;
  }
  class Panel {
    constructor(options){this.options=options;this.webContents=contents();this.visible=false;this.bounds={};views.push(this);}
    getBounds(){return {...this.bounds};} setBounds(value){this.bounds={...value};} setVisible(value){this.visible=value;} setBackgroundColor(){}
  }
  const main=new EventEmitter(); main.bounds={x:40,y:20,width:800,height:700};main.minimum=[720,520];main.maximized=false;main.destroyed=false;
  main.webContents=contents();main.getBounds=()=>({...main.bounds});main.getContentBounds=main.getBounds;
  main.setBounds=value=>Object.assign(main.bounds,value);main.setContentSize=(width,height)=>{Object.assign(main.bounds,{width,height});main.emit('resize');};
  main.getMinimumSize=()=>[...main.minimum];main.setMinimumSize=(width,height)=>{main.minimum=[width,height];};
  main.isMaximized=()=>main.maximized;main.isDestroyed=()=>main.destroyed;
  main.contentView={children:[],addChildView(view){this.children.push(view);},removeChildView(view){this.children=this.children.filter(child=>child!==view);}};
  const screen=new EventEmitter();screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1800,height:1000}});
  const event=own=>({sender:own.webContents,senderFrame:own.webContents.mainFrame});
  const manager=attachAdvisorCompanion({WebContentsView:Panel,ipcMain,screen,mainWindow:main,clientUrl:'http://127.0.0.1:45678/',
    clipboard:{writeText:text=>copied.push(text)},trustedMainFrame:e=>e.sender===main.webContents&&e.senderFrame===main.webContents.mainFrame});
  return {main,views,handlers,ipcMain,manager,copied,event,screen};
}
function envelope(type,scope={account:'a',user:'u',agentId:'advisor',generation:1},payload={}){
  return {envelope:'advisor',nonce:'adv_'+'a'.repeat(32),type,scope,payload};
}
test('one fixed-width internal view expands the original window and restores it when hidden',()=>{
  const f=fixture(),before=f.main.getBounds(),toggle=f.handlers.get('advisor:toggle');
  assert.deepEqual(toggle(f.event(f.main),true),{visible:true});const view=f.views[0];
  assert.equal(f.views.length,1);assert.equal(f.main.contentView.children[0],view);
  assert.equal(f.main.bounds.width,before.width+WIDTH);assert.deepEqual(view.bounds,{x:800,y:36,width:440,height:664});
  assert(view.options.webPreferences.preload.endsWith('advisor-preload.cjs'));assert.equal(view.options.webPreferences.nodeIntegration,false);
  toggle(f.event(f.main),true);assert.equal(f.views.length,1);toggle(f.event(f.main),false);
  assert.equal(view.visible,false);assert.deepEqual(f.main.bounds,before);assert.deepEqual(f.main.minimum,[720,520]);
  f.manager.close();assert.equal(view.webContents.destroyed,true);assert.equal(f.main.contentView.children.length,0);
});
test('bounds meet the left surface in the same local coordinate system',()=>{
  assert.deepEqual(companionBounds({x:-1700,y:40,width:1240,height:600}),{x:800,y:36,width:440,height:564});
});
test('resize and maximization retain fixed width without a second window',()=>{
  const f=fixture(),toggle=f.handlers.get('advisor:toggle');toggle(f.event(f.main),true);
  f.main.bounds.width=1600;f.main.bounds.height=850;f.main.emit('resize');assert.deepEqual(f.views[0].bounds,{x:1160,y:36,width:440,height:814});
  f.main.maximized=true;toggle(f.event(f.main),false);assert.equal(f.main.bounds.width,1600);toggle(f.event(f.main),true);
  assert.equal(f.main.bounds.width,1600);assert.equal(f.views.length,1);f.manager.close();
});
test('a narrow display cannot overlay the chat or open another window',()=>{
  const f=fixture();f.screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1000,height:800}});
  const result=f.handlers.get('advisor:toggle')(f.event(f.main),true);assert.equal(result.visible,false);assert(result.error);assert.equal(f.views.length,0);f.manager.close();
});
test('screen-limited expansion restores the actual added width without cumulative shrink',()=>{
  const f=fixture();f.main.bounds.width=1180;
  f.screen.getDisplayMatching=()=>({workArea:{x:0,y:0,width:1280,height:800}});
  const toggle=f.handlers.get('advisor:toggle'),original=f.main.bounds.width;
  for(let index=0;index<4;index++){
    toggle(f.event(f.main),true);assert(f.main.bounds.width<original+WIDTH);
    toggle(f.event(f.main),false);assert.equal(f.main.bounds.width,original);
  }
  f.manager.close();
});
test('only owned native frames can send state and current scoped actions',()=>{
  const f=fixture(),toggle=f.handlers.get('advisor:toggle');assert.deepEqual(toggle({sender:{},senderFrame:{}}),{visible:false});
  toggle(f.event(f.main),true);const view=f.views[0];f.ipcMain.emit('advisor:from-main',f.event(view),envelope('ADVISOR_INIT'));assert.equal(view.webContents.sent.length,0);
  f.ipcMain.emit('advisor:from-main',f.event(f.main),envelope('ADVISOR_INIT'));assert.equal(view.webContents.sent.length,1);
  const before=f.main.webContents.sent.length;f.ipcMain.emit('advisor:from-window',{sender:{},senderFrame:{}},envelope('ADVISOR_SEND',undefined,{text:'bad'}));assert.equal(f.main.webContents.sent.length,before);
  f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_SEND',undefined,{text:'hello'}));assert.equal(f.main.webContents.sent.length,before+1);
  f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_SEND',{account:'other',user:'u',agentId:'advisor',generation:1},{text:'bad'}));assert.equal(f.main.webContents.sent.length,before+1);
  assert.equal(f.handlers.has('real-client:exit-app'),false);f.manager.close();
});
test('model list and model choice cross the native bridge in both directions',()=>{
  const f=fixture(),toggle=f.handlers.get('advisor:toggle');toggle(f.event(f.main),true);
  const view=f.views[0],scope={account:'a',user:'u',agentId:'advisor',generation:1};
  f.ipcMain.emit('advisor:from-main',f.event(f.main),envelope('ADVISOR_INIT',scope));
  assert.equal(view.webContents.sent.length,1);
  const profiles=[{id:'a'.repeat(32),name:'档案甲',model:'model-a',protocol:'anthropic'}];
  f.ipcMain.emit('advisor:from-main',f.event(f.main),envelope('ADVISOR_SET_MODELS',scope,{profiles,assistantProfileId:null,analysisLabel:'档案甲'}));
  assert.equal(view.webContents.sent.length,2);
  assert.equal(view.webContents.sent[1].value.type,'ADVISOR_SET_MODELS');
  const before=f.main.webContents.sent.length;
  f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_SELECT_MODEL',scope,{profileId:null}));
  assert.equal(f.main.webContents.sent.length,before+1);
  assert.equal(f.main.webContents.sent.at(-1).value.type,'ADVISOR_SELECT_MODEL');
  assert.equal(f.main.webContents.sent.at(-1).value.payload.profileId,null);
  f.manager.close();
});
test('new conversation crosses the native bridge to the main frame',()=>{
  const f=fixture(),toggle=f.handlers.get('advisor:toggle');toggle(f.event(f.main),true);
  const view=f.views[0],scope={account:'a',user:'u',agentId:'advisor',generation:1};
  f.ipcMain.emit('advisor:from-main',f.event(f.main),envelope('ADVISOR_INIT',scope));
  const before=f.main.webContents.sent.length;
  f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_NEW_THREAD',scope));
  assert.equal(f.main.webContents.sent.length,before+1);
  assert.equal(f.main.webContents.sent.at(-1).value.type,'ADVISOR_NEW_THREAD');
  f.manager.close();
});
test('modal suspends the view and copy; hiding leaves the application alive',()=>{
  const f=fixture();f.handlers.get('advisor:toggle')(f.event(f.main),true);const view=f.views[0];f.ipcMain.emit('advisor:from-main',f.event(f.main),envelope('ADVISOR_INIT'));
  f.ipcMain.emit('advisor:modal',f.event(f.main),true);assert.equal(view.visible,false);f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_COPY',undefined,{text:'suggestion'}),true);assert.equal(f.copied.length,0);
  f.ipcMain.emit('advisor:modal',f.event(f.main),false);assert.equal(view.visible,true);f.ipcMain.emit('advisor:from-window',f.event(view),envelope('ADVISOR_COPY',undefined,{text:'suggestion'}),true);assert.deepEqual(f.copied,['suggestion']);
  f.ipcMain.emit('advisor:hide',f.event(view));assert.equal(view.visible,false);assert.equal(f.main.destroyed,false);f.manager.close();
});
test('window teardown closes the panel without accessing a destroyed window webContents',()=>{
  const f=fixture();f.handlers.get('advisor:toggle')(f.event(f.main),true);
  f.main.destroyed=true;Object.defineProperty(f.main,'webContents',{get(){throw new Error('Object has been destroyed');}});
  assert.doesNotThrow(()=>f.manager.close());assert.equal(f.views[0].webContents.destroyed,true);
});
test('conceal publishes the final left width before native resize, without a double-width subtraction',()=>{
  const f=fixture();f.handlers.get('advisor:toggle')(f.event(f.main),true);
  const resize=f.main.setContentSize;
  f.main.setContentSize=(width,height)=>{
    const message=f.main.webContents.sent.filter(item=>item.name==='advisor:layout').at(-1);
    assert.equal(message.value.width,0);assert.equal(message.value.mainWidth,width);
    resize(width,height);
  };
  f.handlers.get('advisor:toggle')(f.event(f.main),false);assert.equal(f.main.bounds.width,800);f.manager.close();
});
