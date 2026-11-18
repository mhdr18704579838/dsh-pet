// ==UserScript==
// @name 大肥鱼直播桥：抖音可见评论（实验性）
// @namespace dsh-pet-live-bridge
// @version 0.1.0
// @match https://live.douyin.com/*
// @grant GM_registerMenuCommand
// @grant GM_xmlhttpRequest
// @connect 127.0.0.1
// ==/UserScript==
// Only reads new visible comment rows selected by the operator. No cookies or hidden APIs are read.
(() => {
  let observer;
  GM_registerMenuCommand('开始转发（需配置真实评论 DOM）', () => {
    if (observer) return alert('正在转发，请先停止');
    const rowSelector=prompt('每一条评论的 CSS 选择器（需在开发者工具确认）'); if(!rowSelector)return;
    const textSelector=prompt('相对评论行的正文选择器（必填，不包含昵称/礼物）'); if(!textSelector)return;
    const userSelector=prompt('相对评论行的昵称选择器（可留空）') || '';
    let existing;
    try{existing=[...document.querySelectorAll(rowSelector)];document.querySelector(textSelector);if(userSelector)document.querySelector(userSelector);}catch{return alert('选择器无效');}
    const sample=existing.map(row=>row.querySelector(textSelector)?.textContent.trim()).find(Boolean);
    if(!sample)return alert('未找到可预览的评论，请等待直播间有评论后重试');
    if(!confirm('将只转发新增评论。当前解析样例：\n'+sample+'\n确认这是评论正文？'))return;
    const token=prompt('直播桥本地访问口令（终端地址 # 后面的部分，不是模型 API Key）');if(!token)return;
    const seen=new WeakSet(existing);
    const forward=row=>{
      if(seen.has(row))return;
      const text=row.querySelector(textSelector)?.textContent.trim();if(!text)return;
      seen.add(row);
      const user=(userSelector?row.querySelector(userSelector)?.textContent.trim():'')||'观众';
      GM_xmlhttpRequest({method:'POST',url:'http://127.0.0.1:39210/events',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},
        data:JSON.stringify({type:'comment',user,text,id:crypto.randomUUID()}),
        onload:r=>{if(r.status!==202){observer.disconnect();observer=null;alert('转发已停止：直播桥返回 '+r.status);}},
        onerror:()=>{if(observer){observer.disconnect();observer=null;alert('连接失败，转发已停止');}}});
    };
    observer=new MutationObserver(records=>{for(const record of records){for(const node of record.addedNodes){if(node.nodeType!==1)continue;if(node.matches(rowSelector))forward(node);node.querySelectorAll(rowSelector).forEach(forward);}const row=record.target.nodeType===1?record.target.closest(rowSelector):record.target.parentElement?.closest(rowSelector);if(row)forward(row);}});
    observer.observe(document.body,{childList:true,subtree:true});alert('开始转发。停止可使用脚本菜单或刷新页面。');
  });
  GM_registerMenuCommand('停止转发',()=>{observer?.disconnect();observer=null;});
})();
