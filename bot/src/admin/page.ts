/**
 * Web console.
 *
 * One self-contained page, no build step and no CDN: the Worker bundle already
 * ships everything, and an admin panel that needs a toolchain is an admin panel
 * that rots. The JS avoids template literals so the whole page can live in one
 * TS string without escaping gymnastics.
 */
import { FIELDS as FIELD_TABLE, FIELD_GROUPS } from "./fields.ts";

/**
 * Field metadata travels into the page as data, not as duplicated JS.
 *
 * The alternative — a second copy of the label table inside the page string —
 * is the drift this file exists to avoid: someone adds a config key, updates
 * `fields.ts`, and the console keeps showing the old name until a user reports
 * it. `JSON.stringify` here means one source, and `test/console-fields.test.ts`
 * asserts that source covers the schema.
 */
const FIELD_DATA = JSON.stringify({ groups: FIELD_GROUPS, fields: FIELD_TABLE });

export function renderConsole(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>焰卫 · 后台</title>
<style>
:root{color-scheme:dark;--bg:#0b0f14;--panel:#111823;--line:#1f2a37;--text:#e6edf3;--muted:#8fa1b5;--accent:#2f81f7;--ok:#3fb950;--warn:#f0b429;--bad:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
header h1{font-size:15px;margin:0;font-weight:600}
header .sp{flex:1}
button{font:inherit;color:var(--text);background:#18212d;border:1px solid var(--line);border-radius:8px;padding:7px 11px;cursor:pointer}
button:hover{border-color:#2b3a4b}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
button.danger{color:var(--bad)}
button.small{padding:3px 8px;font-size:12px}
input,select,textarea{font:inherit;color:var(--text);background:#0b0f14;border:1px solid var(--line);border-radius:8px;padding:7px 9px;width:100%}
textarea{min-height:64px;resize:vertical}
.layout{display:grid;grid-template-columns:260px 1fr;min-height:calc(100vh - 49px)}
aside{border-right:1px solid var(--line);padding:12px;overflow:auto;max-height:calc(100vh - 49px)}
aside .item{padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
aside .item:hover{background:#141d29}
aside .item.on{background:#17263a;border:1px solid #24405e}
aside .item small{color:var(--muted)}
main{padding:18px;overflow:auto;max-height:calc(100vh - 49px)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.tabs button.on{background:#17263a;border-color:#24405e}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}
.card h2{font-size:13px;margin:0 0 10px;color:var(--muted);font-weight:600;letter-spacing:.02em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
label.field{display:block;font-size:12px;color:var(--muted)}
label.field input,label.field select{margin-top:4px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--ok);border-color:#1c3a25}
.pill.bad{color:var(--bad);border-color:#4a1f1f}
.muted{color:var(--muted)}
.login{max-width:380px;margin:14vh auto;padding:22px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.login h1{font-size:17px;margin:0 0 4px}
.err{color:var(--bad);font-size:12px;margin-top:8px;min-height:16px}
.toast{position:fixed;right:16px;bottom:16px;background:#16212e;border:1px solid var(--line);border-radius:10px;padding:10px 14px;opacity:0;transition:opacity .2s}
.toast.on{opacity:1}
.hide{display:none}
canvas{width:100%;height:120px}
/* ---- config form ------------------------------------------------------- */
.note{color:var(--muted);font-size:12px;margin:-4px 0 12px;line-height:1.5}
.fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.field{display:flex;flex-direction:column;gap:6px;padding:11px;border:1px solid var(--line);border-radius:10px;background:#0d131b}
.field.hit{border-color:var(--accent)}
.fhead{display:flex;align-items:baseline;gap:8px;justify-content:space-between}
.flabel{font-size:13px;font-weight:600}
.fkey{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);background:#131c27;border:1px solid var(--line);border-radius:5px;padding:0 5px;white-space:nowrap}
.fhint{font-size:11px;color:var(--muted);line-height:1.45}
.ferr{font-size:11px;color:var(--bad)}
.ferr:empty{display:none}
.fwrap{display:flex;align-items:center;gap:6px}
.unit{font-size:11px;color:var(--muted);white-space:nowrap}
/* A real switch: the previous select-box with 开/关 made the admin read the
   word twice, and an accidental wheel scroll over it changed the setting. */
.sw{position:relative;width:42px;height:24px;border-radius:999px;background:#22303f;border:1px solid var(--line);cursor:pointer;flex:none;padding:0}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#8fa1b5;transition:transform .15s,background .15s}
.sw[aria-checked="true"]{background:#17324f;border-color:#2b5c8a}
.sw[aria-checked="true"]::after{transform:translateX(18px);background:var(--accent)}
.swrow{display:flex;align-items:center;gap:8px}
.swstate{font-size:12px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:12px;padding:4px 9px;border-radius:999px;border:1px solid var(--line);background:#0b0f14;color:var(--muted);cursor:pointer}
.chip.on{background:#17324f;border-color:#2b5c8a;color:var(--text)}
.ladder{display:flex;flex-direction:column;gap:6px}
.lrow{display:grid;grid-template-columns:56px 1fr 82px 26px;gap:6px;align-items:center}
.lrow .tag{font-size:11px;color:var(--muted);text-align:right}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid #2b5c8a;outline-offset:1px}
.savedbar{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;padding:10px 0 4px;background:linear-gradient(180deg,rgba(11,15,20,0),#0b0f14 45%)}
/* Mini App is a phone webview: a 260px fixed sidebar leaves 130px of正文 on a
   390px screen. Below 760px the sidebar becomes a横向 list on top, and the page
   respects the notch/home-indicator insets so the last row is not unreachable. */
@media (max-width:760px){
  .layout{grid-template-columns:1fr;min-height:0}
  aside{border-right:none;border-bottom:1px solid var(--line);max-height:34vh;white-space:nowrap;overflow-y:auto}
  aside .item{display:inline-flex;width:auto;margin:0 6px 6px 0}
  main{max-height:none;padding:14px 12px calc(18px + env(safe-area-inset-bottom))}
  header{padding:10px 12px;gap:8px;flex-wrap:wrap}
  header h1{font-size:14px}
  .login{margin:8vh 12px;max-width:none}
  .grid{grid-template-columns:1fr}
  table{font-size:12px}
}
</style></head>
<body>
<div id="app"></div>
<div id="toast" class="toast"></div>
<script>
(function(){
  var state = { overview:null, chat:null, tab:'rules', error:'', via:'', chatFilter:'', log:{ chatId:0, offset:0, kind:'', hasMore:false, events:[] } };
  var FIELDS = ${FIELD_DATA};
  var META = {};
  FIELDS.fields.forEach(function(f){ META[f.key] = f; });

  // Telegram appends the Mini App payload to the launch URL hash. Reading it
  // here keeps the console free of any external script: no telegram-web-app.js,
  // no CDN, one less thing that can be blocked or rot.
  function telegramInitData(){
    var hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return '';
    var parts = hash.split('&');
    for (var i=0;i<parts.length;i++){
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      if (parts[i].slice(0, eq) === 'tgWebAppData') {
        try { return decodeURIComponent(parts[i].slice(eq+1)); } catch (e) { return ''; }
      }
    }
    return '';
  }
  var TG_INIT = telegramInitData();

  function el(tag, attrs, children){
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function(k){
      if (k === 'class') node.className = attrs[k];
      else if (k.slice(0,2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children||[]).forEach(function(child){ if(child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }
  function toast(msg){ var t=document.getElementById('toast'); t.textContent=msg; t.className='toast on'; setTimeout(function(){ t.className='toast'; }, 1800); }
  function api(path, opts){
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = opts.headers || {};
    if (TG_INIT) opts.headers['x-telegram-init-data'] = TG_INIT;
    if (opts.body && typeof opts.body !== 'string') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.body); }
    return fetch(path, opts).then(function(r){ return r.json().then(function(j){
      if(!r.ok) {
        var e = new Error(j.error||('HTTP '+r.status)); e.status = r.status;
        // A session that expires mid-page used to leave every click dying with a
        // "未登录" toast and no way back. The loginbox check keeps the login
        // POST's own 401 from re-rendering the form it sits in.
        if (r.status === 401 && !document.getElementById('loginbox')) renderLogin(document.getElementById('app'), '');
        throw e;
      }
      return j;
    }); });
  }
  function clear(node){ while(node.firstChild) node.removeChild(node.firstChild); }

  function renderLogin(root, reason){
    root.innerHTML = '';
    var input = el('input', {type:'password', placeholder:'访问密码', autocomplete:'current-password'});
    var err = el('div', {class:'err'});
    if (reason) err.textContent = reason;
    var btn = el('button', {class:'primary', onclick: function(){
      btn.disabled = true;
      api('/api/login', {method:'POST', body:{secret: input.value}})
        .then(function(){ boot(); })
        .catch(function(e){ err.textContent = e.message; btn.disabled = false; });
    }}, ['登录']);

    // Login-code flow: no shared password needed. The admin approves the code
    // from Telegram (/login <code>), the browser polls and signs itself in.
    var codeBox = el('div', {class:'muted', style:'margin-top:14px'});
    var codeBtn = el('button', {onclick:function(){
      codeBtn.disabled = true; codeBox.textContent = '生成中…';
      api('/api/login/request', {method:'POST'}).then(function(res){
        codeBox.innerHTML = '';
        codeBox.appendChild(el('div', null, ['登录码：' + res.code + '（10 分钟内有效）']));
        codeBox.appendChild(el('div', null, ['在群里把它发给机器人：/login ' + res.code]));
        var timer = setInterval(function(){
          api('/api/login/status?code=' + res.code).then(function(st){
            if (!st.approved) return;
            clearInterval(timer);
            codeBox.textContent = '已批准，正在进入…';
            api('/api/login', {method:'POST', body:{code: res.code}}).then(function(){ boot(); })
              .catch(function(e){ err.textContent = e.message; });
          }).catch(function(){ clearInterval(timer); codeBox.textContent = '轮询失败，请刷新重试。'; });
        }, 2500);
      }).catch(function(e){ codeBox.textContent = e.message; codeBtn.disabled = false; });
    }}, ['用 Telegram 登录码登录']);

    var hint = TG_INIT
      ? 'Mini App 身份校验失败——请回 Telegram 重新打开，或用密码登录。'
      : '输入部署时设置的访问密码（ADMIN_PASSWORD），或用下面的 Telegram 登录码。';
    var box = el('div', {class:'login', id:'loginbox'}, [
      el('h1', null, ['焰卫 · 后台']),
      el('div', {class:'muted'}, [hint]),
      el('div', {style:'height:10px'}),
      input, el('div', {style:'height:10px'}), btn,
      el('div', {style:'height:6px'}),
      codeBtn, codeBox, err
    ]);
    root.appendChild(box);
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter') btn.click(); });
    input.focus();
  }

  function renderShell(root){
    clear(root);
    var chips = el('div', {class:'row'});
    chips.appendChild(el('span', {class:'pill ok'}, ['机器人已连接']));
    if (state.overview) {
      if (state.overview.bans) chips.appendChild(el('span', {class:'pill'}, ['黑名单 ' + state.overview.bans]));
      (state.overview.health||[]).forEach(function(h){
        chips.appendChild(el('span', {class:'pill ' + (h.failures>0 ? 'bad':'ok')}, [h.name + (h.failures>0 ? ' ×'+h.failures : ' ok')]));
      });
    }
    var header = el('header', null, [
      el('h1', null, ['焰卫 · 后台']), chips, el('div', {class:'sp'}),
      el('button', {class:'small', onclick:function(){
        // Inside Telegram there is no cookie to drop: the header keeps working,
        // so "退出" has to close the Mini App or it would do nothing visible.
        if (TG_INIT) { TG_INIT = ''; if (window.Telegram && window.Telegram.WebApp) { window.Telegram.WebApp.close(); } }
        api('/api/logout').then(function(){ boot(); }).catch(function(){ boot(); });
      }}, ['退出'])
    ]);
    var aside = el('aside', {id:'chats'});
    var main = el('main', {id:'main'});
    root.appendChild(header);
    root.appendChild(el('div', {class:'layout'}, [aside, main]));
    renderChats();
    renderMain();
  }

  function renderChats(){
    var aside = document.getElementById('chats');
    clear(aside);
    // The search box re-renders only the list below it, so typing keeps focus.
    var search = el('input', {type:'search', placeholder:'搜索群名或 ID', value:state.chatFilter, style:'width:100%;margin-bottom:8px'});
    var listBox = el('div');
    var renderList = function(){
      clear(listBox);
      var needle = state.chatFilter.trim().toLowerCase();
      var all = (state.overview && state.overview.chats) || [];
      var list = !needle ? all : all.filter(function(c){
        return String(c.title||'').toLowerCase().indexOf(needle) >= 0 || String(c.chatId).indexOf(needle) >= 0;
      });
      if (!all.length) listBox.appendChild(el('div', {class:'muted'}, ['还没有群。把机器人拉进群并设为管理员。']));
      else if (!list.length) listBox.appendChild(el('div', {class:'muted'}, ['没有匹配的群。']));
      list.forEach(function(c){
        var on = state.chat && state.chat.chatId === c.chatId;
        // The bot's own rights, from the overview response: moderation is dead
        // in a chat where delete or restrict is missing, so say so inline.
        var r = c.rights;
        var badge = r && (!r.admin || !r.delete || !r.restrict || !r.pin)
          ? el('span', {class:'pill bad', style:'margin-left:6px'}, ['缺权限'])
          : null;
        listBox.appendChild(el('div', {class:'item' + (on?' on':''), onclick:function(){ selectChat(c.chatId); }}, [
          el('span', null, [c.title || String(c.chatId)]),
          badge,
          el('small', null, [String(c.chatId)])
        ]));
      });
    };
    search.addEventListener('input', function(){ state.chatFilter = search.value; renderList(); });
    aside.appendChild(search);
    aside.appendChild(listBox);
    aside.appendChild(el('div', {style:'height:10px'}));
    // Operator-only shortcuts: a Mini App group admin has no global view, and
    // the overview response omits the bans field for them on purpose.
    if (state.overview && state.overview.bans !== undefined) {
      aside.appendChild(el('button', {class:'small', onclick:function(){ loadBans(); }}, ['全局黑名单']));
      aside.appendChild(el('div', {style:'height:6px'}));
      aside.appendChild(el('button', {class:'small', onclick:function(){ loadPreset(); }}, ['新群预设']));
    }
    renderList();
  }

  function selectChat(id){
    state.tab = 'rules';
    state.log = { chatId:0, offset:0, kind:'', hasMore:false, events:[] };
    api('/api/chat/' + id).then(function(data){ state.chat = data; renderChats(); renderMain(); }).catch(function(e){ toast(e.message); });
  }

  // Re-pull the chat data without switching tabs: saving in the AI tab must not
  // throw the admin back to the rules form and reset their scroll.
  function refreshChat(){
    return api('/api/chat/' + state.chat.chatId).then(function(data){ state.chat = data; renderMain(); }).catch(function(e){ toast(e.message); });
  }

  // The member view: roster + activity + warnings + inline actions. Data comes
  // from its own endpoint because it pages independently of the chat bundle.
  var memberState = { q: '', offset: 0, hasMore: false, pageSize: 50 };
  function renderMembers(){
    var main = document.getElementById('main');
    clear(main);
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['成员']));
    var search = el('input', {type:'search', placeholder:'搜索昵称 / 用户名 / ID', value:memberState.q});
    var doSearch = function(){ memberState.q = search.value.trim(); loadMembers(0); };
    search.addEventListener('keydown', function(e){ if(e.key === 'Enter') doSearch(); });
    card.appendChild(el('div', {class:'row', style:'margin-bottom:8px'}, [search, el('button', {class:'small', onclick:doSearch}, ['搜索'])]));
    card.appendChild(el('div', {id:'member-rows'}, [el('div', {class:'muted'}, ['加载中…'])]));
    if (memberState.offset > 0 || memberState.hasMore) {
      var nav = el('div', {class:'row', id:'member-nav', style:'margin-top:8px'});
      card.appendChild(nav);
    }
    main.appendChild(card);
    loadMembers(memberState.offset);
  }

  function memberAction(userId, action, label){
    var btn = el('button', {class:'small' + (action === 'kick' ? ' danger' : ''), onclick:function(){
      btn.disabled = true;
      api('/api/chat/' + state.chat.chatId + '/member/' + userId + '/' + action, {method:'POST'})
        .then(function(){ toast('已' + label); loadMembers(memberState.offset); })
        .catch(function(e){ toast(e.message); btn.disabled = false; });
    }}, [label]);
    return btn;
  }

  function loadMembers(offset){
    var params = new URLSearchParams({ offset: String(offset || 0), limit: String(memberState.pageSize) });
    if (memberState.q) params.set('q', memberState.q);
    api('/api/chat/' + state.chat.chatId + '/members?' + params.toString()).then(function(res){
      memberState.offset = res.offset || 0;
      memberState.hasMore = Boolean(res.hasMore);
      var box = document.getElementById('member-rows');
      if (!box) return;
      clear(box);
      var table = el('table', null, [el('tr', null, [el('th',null,['成员']), el('th',null,['7 天发言']), el('th',null,['警告']), el('th',null,['入群']), el('th',null,['最近发言']), el('th',null,['操作'])])]);
      (res.members||[]).forEach(function(m){
        var name = m.firstName || (m.username ? '@' + m.username : String(m.userId));
        table.appendChild(el('tr', null, [
          el('td', null, [el('b', null, [name]), el('span', {class:'muted', style:'margin-left:6px'}, [String(m.userId)]), m.blocked ? el('span', {class:'pill bad', style:'margin-left:6px'}, ['已屏蔽']) : null]),
          el('td', null, [String(m.week)]),
          el('td', null, [m.warnings > 0 ? String(m.warnings) : '-']),
          el('td', null, [m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : '-']),
          el('td', null, [m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString() : '-']),
          el('td', null, [memberAction(m.userId, 'mute', '禁言'), ' ', memberAction(m.userId, 'unmute', '解除'), ' ', memberAction(m.userId, 'kick', '移出')])
        ]));
      });
      if (!(res.members||[]).length) table.appendChild(el('tr', null, [el('td', {class:'muted'}, ['还没有成员记录（成员在发言或进群后出现）']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
      box.appendChild(table);
      var nav = document.getElementById('member-nav');
      if (nav) {
        clear(nav);
        if (memberState.offset > 0) nav.appendChild(el('button', {class:'small', onclick:function(){ loadMembers(Math.max(0, memberState.offset - memberState.pageSize)); }}, ['← 上一页']));
        if (memberState.hasMore) nav.appendChild(el('button', {class:'small', onclick:function(){ loadMembers(memberState.offset + memberState.pageSize); }}, ['下一页 →']));
      }
    }).catch(function(e){ toast(e.message); });
  }

  // One page of the event log. The endpoint returns hasMore by fetching one
  // row past the limit, so paging needs no separate count query.
  function loadEvents(chatId, offset, kind){
    var params = new URLSearchParams({ offset: String(offset), limit: '20' });
    if (kind) params.set('kind', kind);
    return api('/api/chat/' + chatId + '/events?' + params.toString()).then(function(res){
      state.log = { chatId: chatId, offset: res.offset, kind: kind, hasMore: Boolean(res.hasMore), events: res.events || [] };
      if (state.tab === 'stats') renderMain();
    }).catch(function(e){ toast(e.message); });
  }

  // The protection table: every guard the bot enforces, one row each, with a
  // status toggle and an inline editor — the shape worth copying from the
  // reference console. Rows read and write plain config fields, so saving goes
  // through the same validated PATCH as every other form here.
  var LOCK_LABELS = {links:'链接',photos:'图片',videos:'视频',stickers:'贴纸',gifs:'动图',files:'文件',polls:'投票',voice:'语音',forwards:'转发',invites:'邀请链接',mentions:'@提及',bots:'机器人',channels:'频道'};
  var protectEditKey = '';
  function protectRow(name, desc, on, togglePatch, editor){
    var cfg = state.chat.config;
    var row = el('div', {class:'row', style:'border-bottom:1px solid #1f2a37;padding:8px 0;align-items:center'}, [
      el('b', {style:'width:150px'}, [name]),
      el('span', {class:'muted', style:'flex:1'}, [desc]),
      el('button', {class:'small' + (on ? '' : ' danger'), onclick:function(){
        api('/api/chat/' + state.chat.chatId + '/config', {method:'PATCH', body: togglePatch(cfg)}).then(function(res){
          state.chat.config = res.config; renderProtect();
        }).catch(function(e){ toast(e.message); });
      }}, [on ? '已启用' : '已停用'])
    ]);
    if (editor) {
      row.appendChild(el('button', {class:'small', style:'margin-left:8px', onclick:function(){
        protectEditKey = protectEditKey === name ? '' : name; renderProtect();
      }}, ['编辑']));
      if (protectEditKey === name) {
        var wrap = el('div', {class:'row', style:'padding:6px 0 10px 150px;flex-wrap:wrap'});
        editor(wrap, function(patch){
          api('/api/chat/' + state.chat.chatId + '/config', {method:'PATCH', body: patch}).then(function(res){
            state.chat.config = res.config; toast('已保存'); renderProtect();
          }).catch(function(e){ toast(e.message); });
        });
        row.appendChild(wrap);
      }
    }
    return row;
  }

  function numInput(value, min, max){
    return el('input', {type:'number', value:String(value), min:String(min), max:String(max), style:'width:90px'});
  }

  function renderProtect(){
    var cfg = state.chat.config;
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['防护开关']));
    card.appendChild(el('div', {class:'muted', style:'margin-bottom:8px'}, ['每一行是一道独立防线；开关立即生效。处置动作（删除/禁言）在「规则」页统一设置。']));

    (state.overview.lockKinds || []).forEach(function(kind){
      card.appendChild(protectRow('禁止' + (LOCK_LABELS[kind] || kind), '删除包含' + (LOCK_LABELS[kind] || kind) + '的消息', cfg.locks.indexOf(kind) >= 0, function(c){
        var next = c.locks.indexOf(kind) >= 0 ? c.locks.filter(function(k){ return k !== kind; }) : c.locks.concat([kind]);
        return { locks: next };
      }));
    });

    card.appendChild(protectRow('超长内容', '超过字数上限的消息删除（0 = 关）', cfg.maxLength > 0, function(c){ return { maxLength: c.maxLength > 0 ? 0 : 1200 }; }, function(wrap, save){
      var input = numInput(cfg.maxLength, 0, 4000);
      wrap.appendChild(input);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ maxLength: Number(input.value) }); }}, ['保存']));
    }));

    card.appendChild(protectRow('违禁词', cfg.keywords.length + ' 个词，' + (cfg.keywordPatterns||[]).length + ' 条正则', cfg.keywords.length > 0 || (cfg.keywordPatterns||[]).length > 0, function(c){
      return { keywords: c.keywords.length ? [] : ['加微信', '代理', '博彩', '日赚', '兼职刷单'] };
    }, function(wrap){
      wrap.appendChild(el('span', {class:'muted'}, ['词条在「规则」页维护，这里只做总开关。']));
    }));

    card.appendChild(protectRow('夜间模式', cfg.nightStart + '–' + cfg.nightEnd + ' 只许管理员发言', Boolean(cfg.nightMode), function(c){ return { nightMode: !c.nightMode }; }, function(wrap, save){
      var s = el('input', {value:cfg.nightStart, style:'width:90px'});
      var e = el('input', {value:cfg.nightEnd, style:'width:90px'});
      wrap.appendChild(s); wrap.appendChild(e);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ nightStart: s.value, nightEnd: e.value }); }}, ['保存']));
    }));

    card.appendChild(protectRow('防刷屏', cfg.floodLimit > 0 ? cfg.floodLimit + ' 条 / ' + cfg.floodWindow + ' 秒' : '关', cfg.floodLimit > 0, function(c){ return { floodLimit: c.floodLimit > 0 ? 0 : 5 }; }, function(wrap, save){
      var limit = numInput(cfg.floodLimit || 5, 1, 60);
      var window_ = numInput(cfg.floodWindow, 3, 3600);
      wrap.appendChild(limit); wrap.appendChild(window_);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ floodLimit: Number(limit.value), floodWindow: Number(window_.value) }); }}, ['保存']));
    }));

    card.appendChild(protectRow('防炸群', cfg.joinRateMax > 0 ? cfg.joinRateMax + ' 人 / ' + cfg.joinRateWindow + ' 秒，触发' + (cfg.joinRateAction === 'lock' ? '锁群' : '提醒') : '关', cfg.joinRateMax > 0, function(c){ return { joinRateMax: c.joinRateMax > 0 ? 0 : 12 }; }, function(wrap, save){
      var max = numInput(cfg.joinRateMax || 12, 1, 200);
      var win = numInput(cfg.joinRateWindow, 5, 600);
      var act = el('select', null, [el('option',{value:'notify'},['仅提醒']), el('option',{value:'lock'},['自动锁群'])]);
      act.value = cfg.joinRateAction;
      wrap.appendChild(max); wrap.appendChild(win); wrap.appendChild(act);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ joinRateMax: Number(max.value), joinRateWindow: Number(win.value), joinRateAction: act.value }); }}, ['保存']));
    }));

    card.appendChild(protectRow('新人限制', '入群 ' + cfg.newbieHours + ' 小时内禁' + (cfg.newbieBlocks||[]).join('、'), cfg.newbieHours > 0, function(c){ return { newbieHours: c.newbieHours > 0 ? 0 : 24 }; }, function(wrap, save){
      var hours = numInput(cfg.newbieHours, 0, 720);
      wrap.appendChild(hours);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ newbieHours: Number(hours.value) }); }}, ['保存']));
    }));

    card.appendChild(protectRow('AI 图片审核', cfg.ai ? cfg.aiProvider + '，阈值 ' + cfg.aiMinScore : '关（需部署 VISION_KEY）', Boolean(cfg.ai), function(c){ return { ai: !c.ai }; }, function(wrap){
      wrap.appendChild(el('span', {class:'muted'}, ['阈值与预算在「AI 审核」页调。']));
    }));

    card.appendChild(protectRow('自动解析链接', cfg.parseAuto ? '每小时至多 ' + cfg.parsePerHour + ' 条' : '关', Boolean(cfg.parseAuto), function(c){ return { parseAuto: !c.parseAuto }; }, function(wrap, save){
      var per = numInput(cfg.parsePerHour, 1, 200);
      wrap.appendChild(per);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ parsePerHour: Number(per.value) }); }}, ['保存']));
    }));

    card.appendChild(protectRow('新人验证', cfg.captcha ? ({button:'按钮',math:'算术',question:'问答',image:'图形验证码',subscribe:'订阅频道'})[cfg.captchaMode] : '关', Boolean(cfg.captcha), function(c){ return { captcha: !c.captcha }; }, function(wrap, save){
      var mode = el('select', null, [
        el('option',{value:'button'},['按钮']), el('option',{value:'math'},['算术']),
        el('option',{value:'question'},['问答']), el('option',{value:'image'},['图形验证码']),
        el('option',{value:'subscribe'},['订阅频道'])
      ]);
      mode.value = cfg.captchaMode;
      wrap.appendChild(mode);
      wrap.appendChild(el('button', {class:'small primary', onclick:function(){ save({ captchaMode: mode.value }); }}, ['保存']));
    }));

    return card;
  }

  function renderMain(){
    var main = document.getElementById('main');
    clear(main);
    if (!state.chat) {
      var board = state.overview && state.overview.board;
      if (board) {
        var stat = el('div', {class:'card'});
        stat.appendChild(el('h2', null, ['数据看板']));
        var line = function(label, t, y){
          return el('div', {class:'row', style:'padding:4px 0'}, [
            el('span', {style:'width:160px'}, [label]),
            el('b', null, [String(t||0)]),
            el('span', {class:'muted', style:'width:80px;text-align:right'}, ['昨日 ' + (y||0)])
          ]);
        };
        stat.appendChild(line('今日进群', board.today && board.today.join, board.yesterday && board.yesterday.join));
        stat.appendChild(line('今日退群', board.today && board.today.leave, board.yesterday && board.yesterday.leave));
        main.appendChild(stat);
      }
      var totals = (state.overview && state.overview.totals) || {};
      var table = el('table', null, [el('tr', null, [el('th',null,['动作']), el('th',null,['近 7 天'])])]);
      Object.keys(totals).forEach(function(k){ table.appendChild(el('tr', null, [el('td',null,[label(k)]), el('td',null,[String(totals[k])])])); });
      main.appendChild(el('div', {class:'card'}, [el('h2',null,['全部群 · 近 7 天']), table]));
      main.appendChild(el('div', {class:'card'}, [el('h2',null,['说明']), el('div', {class:'muted'}, ['从左侧选一个群开始；群内也可以用 /panel 打开同样的菜单。'])]));
      return;
    }
    var tabs = el('div', {class:'tabs'});
    [['rules','规则'],['protect','防护'],['members','成员'],['stats','统计'],['ai','AI 审核'],['parse','解析'],['words','热词'],['blocks','屏蔽'],['sync','同步'],['notes','说明'],['filters','自动回复'],['sched','定时消息'],['tools','工具箱']].forEach(function(pair){
      tabs.appendChild(el('button', {class: pair[0]===state.tab?'on':'', onclick:function(){ state.tab=pair[0]; renderMain(); }}, [pair[1]]));
    });
    main.appendChild(tabs);
    if (state.tab === 'rules') main.appendChild(renderRules());
    if (state.tab === 'protect') main.appendChild(renderProtect());
    if (state.tab === 'members') renderMembers();
    if (state.tab === 'stats') main.appendChild(renderStats());
    if (state.tab === 'notes') main.appendChild(renderNotes());
    if (state.tab === 'filters') main.appendChild(renderFilters());
    if (state.tab === 'sched') main.appendChild(renderSched());
    if (state.tab === 'blocks') main.appendChild(renderBlocks());
    if (state.tab === 'sync') main.appendChild(renderSync());
    if (state.tab === 'tools') main.appendChild(renderTools());
    if (state.tab === 'ai') main.appendChild(renderAi());
    if (state.tab === 'parse') main.appendChild(renderParse());
    if (state.tab === 'words') main.appendChild(renderWords());
  }


  function bar(value, max, color){
    var wrap = el('div', {style:'background:#0b0f14;border:1px solid #1f2a37;border-radius:6px;height:8px;flex:1'});
    var fill = el('div', {style:'height:8px;border-radius:6px;background:' + (color||'#2f81f7') + ';width:' + (max>0 ? Math.max(2, Math.round(value/max*100)) : 0) + '%'});
    wrap.appendChild(fill);
    return wrap;
  }

  function featurePatch(path, body, done){
    // The response already carries the saved config — updating it in place
    // costs one request instead of re-pulling the whole chat data bundle.
    api('/api/chat/' + state.chat.chatId + '/' + path, {method:'POST', body: body}).then(function(res){
      state.chat.config = res.config; toast('已保存 ' + (res.changed||[]).join(',')); done && done();
      renderMain();
    }).catch(function(e){ toast(e.message); });
  }

  function renderAi(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['图片 / 贴纸 / 视频封面审核']));
    var cfg = state.chat.config;
    var on = el('select', null, [el('option',{value:'true'},['开']), el('option',{value:'false'},['关'])]);
    on.value = String(cfg.ai);
    var provider = el('select', null, [el('option',{value:'generic'},['generic（自建/国产 API）']), el('option',{value:'cloud-vision'},['cloud-vision（Google）'])]);
    provider.value = cfg.aiProvider;
    var min = el('input', {type:'number', value:String(cfg.aiMinScore), min:'50', max:'100'});
    var budget = el('input', {type:'number', value:String(cfg.aiDailyBudget), min:'10', max:'20000'});
    var cats = el('input', {value:(cfg.aiCategories||[]).join(',')});
    var save = el('button', {class:'primary', onclick:function(){
      featurePatch('ai', {
        ai: on.value === 'true',
        aiProvider: provider.value,
        aiMinScore: Number(min.value),
        aiDailyBudget: Number(budget.value),
        aiCategories: cats.value.split(',').map(function(s){return s.trim();}).filter(Boolean)
      });
    }}, ['保存']);
    card.appendChild(el('div', {class:'grid'}, [
      el('label', {class:'field'}, ['开关', on]),
      el('label', {class:'field'}, ['通道', provider]),
      el('label', {class:'field'}, ['阈值 50-100', min]),
      el('label', {class:'field'}, ['每日预算（次）', budget]),
      el('label', {class:'field'}, ['类别 nsfw,gambling,ad,qr', cats])
    ]));
    card.appendChild(el('div', {style:'height:10px'}));
    card.appendChild(save);
    card.appendChild(el('div', {class:'muted', style:'margin-top:8px'}, ['需要部署配置 VISION_KEY（generic 还要 VISION_URL）。不可达时 fail-open：宁可漏审，不误杀。']));

    // The usage rows already ship with /api/chat/:id — they were just never drawn.
    var usage = state.chat.ai && state.chat.ai.usage;
    if (usage) {
      card.appendChild(el('h2', {style:'margin-top:16px'}, ['今日用量 · ' + (state.chat.day || '')]));
      card.appendChild(el('div', {class:'row'}, [
        el('span', {class:'pill'}, ['调用 ' + (usage.calls||0)]),
        el('span', {class:'pill ' + (usage.hits ? 'bad' : 'ok')}, ['命中 ' + (usage.hits||0)]),
        el('span', {class:'pill'}, ['失败 ' + (usage.failures||0)]),
        el('span', {class:'pill'}, ['均耗时 ' + (usage.calls ? Math.round((usage.ms||0)/usage.calls) : 0) + 'ms'])
      ]));
    }
    var series = (state.chat.ai && state.chat.ai.series) || [];
    if (series.length) {
      card.appendChild(el('h2', {style:'margin-top:16px'}, ['近 7 天调用']));
      var smax = series.reduce(function(m, r){ return Math.max(m, r.calls); }, 0);
      series.forEach(function(r){
        card.appendChild(el('div', {class:'row', style:'padding:3px 0'}, [
          el('span', {style:'width:120px'}, [r.day]),
          bar(r.calls, smax),
          el('span', {class:'muted', style:'width:64px;text-align:right'}, [String(r.calls)])
        ]));
      });
    }
    return card;
  }

  function renderParse(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['链接解析（抖音 / 小红书 / X / B 站）']));
    var cfg = state.chat.config;
    var on = el('select', null, [el('option',{value:'true'},['开']), el('option',{value:'false'},['关'])]);
    on.value = String(cfg.parseAuto);
    var per = el('input', {type:'number', value:String(cfg.parsePerHour), min:'1', max:'200'});
    var save = el('button', {class:'primary', onclick:function(){ featurePatch('parse', {parseAuto: on.value === 'true', parsePerHour: Number(per.value)}); }}, ['保存']);
    card.appendChild(el('div', {class:'grid'}, [
      el('label', {class:'field'}, ['自动解析群里出现的链接', on]),
      el('label', {class:'field'}, ['每小时上限', per])
    ]));
    card.appendChild(el('div', {style:'height:10px'}));
    card.appendChild(save);

    var stats = state.chat.parse.stats || {total:0,done:0,failed:0,pending:0};
    var rate = stats.total ? Math.round(stats.failed / stats.total * 100) : 0;
    card.appendChild(el('h2', {style:'margin-top:16px'}, ['近 30 天']));
    card.appendChild(el('div', {class:'row'}, [
      el('span', {class:'pill ok'}, ['成功 ' + stats.done]),
      el('span', {class:'pill ' + (stats.failed ? 'bad' : 'ok')}, ['失败 ' + stats.failed + '（' + rate + '%）']),
      el('span', {class:'pill'}, ['排队 ' + stats.pending]),
      el('span', {class:'pill'}, ['媒体 ' + stats.media])
    ]));

    var table = el('table', null, [el('tr', null, [el('th',null,['时间']), el('th',null,['站']), el('th',null,['状态']), el('th',null,['模式']), el('th',null,['媒体']), el('th',null,['错误'])])]);
    (state.chat.parse.jobs||[]).forEach(function(j){
      table.appendChild(el('tr', null, [
        el('td',null,[new Date(j.at).toLocaleString()]),
        el('td',null,[j.site||'-']),
        el('td',null,[el('span',{class:'pill ' + (j.status==='done'?'ok':(j.status==='failed'?'bad':''))},[j.status])]),
        el('td',null,[j.mode]),
        el('td',null,[String(j.media)]),
        el('td',{class:'muted'},[String(j.error||'').slice(0,60)])
      ]));
    });
    if (!(state.chat.parse.jobs||[]).length) table.appendChild(el('tr', null, [el('td',{class:'muted', colspan:'6'},['还没有记录'])]));
    card.appendChild(table);
    return card;
  }

  function renderWords(){
    var card = el('div', {class:'card'});
    var top = state.chat.words.top || [];
    card.appendChild(el('h2', null, ['今天的热词 · ' + (state.chat.day || '')]));
    if (!top.length) card.appendChild(el('div', {class:'muted'}, ['还没有足够的数据（同一个词至少出现在 2 条消息里）。']));
    var max = top.reduce(function(m, r){ return Math.max(m, r.count); }, 0);
    top.forEach(function(r){
      card.appendChild(el('div', {class:'row', style:'padding:3px 0'}, [
        el('span', {style:'width:120px'}, [r.word]),
        bar(r.count, max),
        el('span', {class:'muted', style:'width:44px;text-align:right'}, [String(r.count)])
      ]));
    });
    card.appendChild(el('h2', {style:'margin-top:16px'}, ['近 7 天发言量']));
    var totals = state.chat.words.totals || [];
    var tmax = totals.reduce(function(m, r){ return Math.max(m, r.words); }, 0);
    totals.forEach(function(r){
      card.appendChild(el('div', {class:'row', style:'padding:3px 0'}, [
        el('span', {style:'width:120px'}, [r.day]),
        bar(r.words, tmax, '#3fb950'),
        el('span', {class:'muted', style:'width:64px;text-align:right'}, [r.words + ' 词'])
      ]));
    });
    card.appendChild(el('div', {class:'muted', style:'margin-top:10px'}, ['中文按二元组切分，功能词已过滤；只统计未被处置的消息。']));
    return card;
  }

  function label(k){
    var map = {delete:'删除',mute:'禁言',ban:'封禁',kick:'移出',warn:'警告',verify:'验证',join:'进群',leave:'退群',external:'外部',trust:'信任',block:'屏蔽',watch:'只记录'};
    return map[k] || k;
  }

  function renderRules(){
    var cfg = state.chat.config;
    var wrap = el('div', null);

    var filter = el('input', {type:'search', placeholder:'搜索设置，例如「验证」或 captcha'});
    wrap.appendChild(el('div', {class:'card', style:'padding:10px'}, [
      filter,
      el('div', {class:'note', style:'margin:8px 0 0'}, ['改完立刻生效，不需要保存按钮。右上角的小字是给 /set 用的原始字段名。'])
    ]));

    var slots = {};
    FIELDS.groups.forEach(function(group){
      var body = el('div', {class:'fields'});
      var card = el('div', {class:'card'}, [
        el('h2', null, [group.title]),
        group.note ? el('div', {class:'note'}, [group.note]) : null,
        body
      ]);
      slots[group.id] = body;
      wrap.appendChild(card);
    });

    FIELDS.fields.forEach(function(meta){
      var body = slots[meta.group];
      if (!body || !(meta.key in cfg)) return;
      body.appendChild(fieldRow(meta, cfg[meta.key]));
    });

    // Anything the schema grew but this table does not know yet still gets a
    // control. Losing it silently is worse than rendering it under a raw name.
    var known = {};
    FIELDS.fields.forEach(function(f){ known[f.key] = 1; });
    var extra = Object.keys(cfg).filter(function(k){ return !known[k]; });
    if (extra.length) {
      var extraBody = el('div', {class:'fields'});
      extra.forEach(function(key){
        extraBody.appendChild(fieldRow({key:key, label:key, hint:'这个字段还没有中文说明。', kind:guessKind(cfg[key])}, cfg[key]));
      });
      wrap.appendChild(el('div', {class:'card'}, [el('h2', null, ['其它']), extraBody]));
    }

    filter.addEventListener('input', function(){
      var q = filter.value.trim().toLowerCase();
      Array.prototype.forEach.call(wrap.querySelectorAll('.field'), function(row){
        var hay = (row.dataset.key + ' ' + (row.dataset.label || '')).toLowerCase();
        row.classList.toggle('hide', q.length > 0 && hay.indexOf(q) < 0);
      });
    });

    wrap.appendChild(rawJsonCard());
    wrap.appendChild(exportImportCard());
    return wrap;
  }

  function guessKind(value){
    if (typeof value === 'boolean') return 'switch';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'list';
    return 'text';
  }

  function fieldRow(meta, value){
    var row = el('div', {class:'field'});
    row.dataset.key = meta.key;
    row.dataset.label = meta.label || '';
    row.appendChild(el('div', {class:'fhead'}, [
      el('span', {class:'flabel'}, [meta.label || meta.key]),
      el('code', {class:'fkey'}, [meta.key])
    ]));
    var err = el('div', {class:'ferr'});
    row.appendChild(controlFor(meta, value, err));
    if (meta.hint) row.appendChild(el('div', {class:'fhint'}, [meta.hint]));
    row.appendChild(err);
    return row;
  }

  function controlFor(meta, value, err){
    var wrap = el('div', {class:'fwrap'});

    // write() owns one field: it sends only this key, shows the failure under
    // the control and puts the old value back. A toast alone left the form
    // showing a value the server had rejected.
    function write(next, revert){
      err.textContent = '';
      api('/api/chat/' + state.chat.chatId + '/config', {method:'PATCH', body: JSON.parse('{"' + meta.key + '":' + JSON.stringify(next) + '}')})
        .then(function(res){ state.chat.config = res.config; toast(meta.label + '：已保存'); })
        .catch(function(e){ err.textContent = e.message; if (revert) revert(); });
    }

    if (meta.kind === 'switch') {
      var sw = el('button', {class:'sw', role:'switch', 'aria-checked': value ? 'true' : 'false'});
      var lab = el('span', {class:'swstate'}, [value ? '已开启' : '已关闭']);
      sw.addEventListener('click', function(){
        var next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        lab.textContent = next ? '已开启' : '已关闭';
        write(next, function(){ sw.setAttribute('aria-checked', next ? 'false' : 'true'); lab.textContent = next ? '已关闭' : '已开启'; });
      });
      wrap.appendChild(sw);
      wrap.appendChild(lab);
      return wrap;
    }

    if (meta.kind === 'select') {
      var sel = el('select', null, (meta.options || []).map(function(o){
        var opt = el('option', {value:o.value}, [o.label + '（' + o.value + '）']);
        return opt;
      }));
      sel.value = String(value);
      sel.addEventListener('change', function(){ write(sel.value, function(){ sel.value = String(value); }); });
      wrap.appendChild(sel);
      return wrap;
    }

    if (meta.kind === 'number') {
      var inp = el('input', {type:'number', value:String(value)});
      inp.addEventListener('change', function(){
        var n = Number(inp.value);
        if (!isFinite(n)) { err.textContent = '要填数字'; inp.value = String(value); return; }
        write(n, function(){ inp.value = String(value); });
      });
      wrap.appendChild(inp);
      if (meta.unit) wrap.appendChild(el('span', {class:'unit'}, [meta.unit]));
      return wrap;
    }

    if (meta.kind === 'locks') {
      var chips = el('div', {class:'chips'});
      var selected = Array.isArray(value) ? value.slice() : [];
      (meta.options || []).forEach(function(o){
        var on = selected.indexOf(o.value) >= 0;
        var chip = el('button', {class:'chip' + (on ? ' on' : '')}, [o.label]);
        chip.addEventListener('click', function(){
          var i = selected.indexOf(o.value);
          if (i >= 0) selected.splice(i, 1); else selected.push(o.value);
          chip.classList.toggle('on');
          write(selected.slice(), function(){ chip.classList.toggle('on'); });
        });
        chips.appendChild(chip);
      });
      wrap.appendChild(chips);
      return wrap;
    }

    if (meta.kind === 'ladder') {
      return ladderControl(value, err);
    }

    if (meta.kind === 'list') {
      var listInp = el('input', {value: Array.isArray(value) ? value.join(',') : String(value)});
      listInp.addEventListener('change', function(){
        // The comma list accepts ASCII comma, full-width comma, ideographic comma
        // and newlines — admins paste from chats and spreadsheets.
        var parts = listInp.value.split(/[,，、\\n]+/).map(function(s){ return s.trim(); }).filter(Boolean);
        var next = meta.key === 'adWhitelist'
          ? parts.map(Number).filter(function(n){ return isFinite(n) && n > 0; })
          : parts;
        write(next, function(){ listInp.value = Array.isArray(value) ? value.join(',') : String(value); });
      });
      wrap.appendChild(listInp);
      return wrap;
    }

    var inp2 = el('input', {value: String(value)});
    inp2.addEventListener('change', function(){ write(inp2.value, function(){ inp2.value = String(value); }); });
    wrap.appendChild(inp2);
    return wrap;
  }

  // The ladder is the field admins touch most and the only one that used to be
  // editable exclusively as raw JSON. Rows beat a textarea here: 第 N 次 / 处理
  // / 时长 is the sentence an admin actually has in their head.
  function ladderControl(value, err){
    var rows = Array.isArray(value) ? value.map(function(s){ return {at:s.at, action:s.action, minutes:s.minutes}; }) : [];
    var box = el('div', {class:'ladder'});
    var ACTIONS = [['mute','禁言'],['ban','封禁'],['kick','移出'],['warn','只警告']];
    box.appendChild(el('div', {class:'lrow'}, [
      el('span', {class:'tag'}, ['第几次']),
      el('span', {class:'tag', style:'text-align:left'}, ['怎么处理']),
      el('span', {class:'tag'}, ['时长(分)']),
      el('span', null, [''])
    ]));
    function save(next){
      err.textContent = '';
      api('/api/chat/' + state.chat.chatId + '/config', {method:'PATCH', body:{strikes: next}})
        .then(function(res){ state.chat.config = res.config; toast('违规阶梯：已保存'); renderMain(); })
        .catch(function(e){ err.textContent = e.message; });
    }
    rows.forEach(function(row, index){
      var at = el('input', {type:'number', value:String(row.at), min:'1', max:'20'});
      var act = el('select', null, ACTIONS.map(function(p){ return el('option', {value:p[0]}, [p[1]]); }));
      act.value = row.action;
      var mins = el('input', {type:'number', value:String(row.minutes), min:'0'});
      var del = el('button', {class:'small danger', title:'删除这一级'}, ['×']);
      at.addEventListener('change', function(){ var n = Math.max(1, Math.min(20, Number(at.value) || 1)); rows[index].at = n; save(rows); });
      // A ban has no duration; leaving the box editable invites "ban for 60
      // minutes" and then a report that it never lifted.
      act.addEventListener('change', function(){
        rows[index].action = act.value;
        mins.disabled = act.value === 'ban';
        if (mins.disabled) mins.value = '0';
        save(rows);
      });
      mins.addEventListener('change', function(){ var n = Math.max(0, Number(mins.value) || 0); rows[index].minutes = n; save(rows); });
      del.addEventListener('click', function(){ rows.splice(index, 1); save(rows); });
      if (row.action === 'ban') { mins.value = '0'; mins.disabled = true; }
      box.appendChild(el('div', {class:'lrow'}, [at, act, mins, del]));
    });
    box.appendChild(el('button', {class:'small', onclick:function(){
      var nextAt = rows.length ? Math.max.apply(null, rows.map(function(r){ return r.at; })) + 1 : 1;
      rows.push({at: nextAt, action:'mute', minutes:60});
      save(rows);
    }}, ['+ 加一级']));
    return box;
  }

  // Escape hatch for the one thing a form is bad at: copying a whole
  // configuration from another group. Collapsed by default, and it only sends
  // the keys present in the textarea — patchError + saveConfig still apply
  // the same zod validation as every other control.
  function rawJsonCard(){
    var area = el('textarea', {id:'rawjson', style:'min-height:150px;font:12px ui-monospace,Menlo,monospace'});
    area.value = JSON.stringify(state.chat.config, null, 2);
    var apply = el('button', {class:'primary', onclick:function(){
      var parsed;
      try { parsed = JSON.parse(area.value); } catch(e){ toast('JSON 不合法，没有保存'); return; }
      api('/api/chat/' + state.chat.chatId + '/config', {method:'PATCH', body:parsed})
        .then(function(res){ state.chat.config = res.config; toast('已保存 ' + ((res.changed || []).join('、') || '无变化')); renderMain(); })
        .catch(function(e){ toast(e.message); });
    }}, ['应用 JSON']);
    return el('details', {class:'card'}, [
      el('summary', {style:'cursor:pointer;color:var(--muted);font-size:13px'}, ['高级：批量编辑原始 JSON']),
      el('div', {class:'note', style:'margin:10px 0 6px'}, ['从别的群复制整套配置时用。只提交这里出现的键，没出现的字段不会被改动。']),
      area,
      el('div', {style:'height:8px'}),
      apply
    ]);
  }

  function renderStats(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['近 30 天']));
    var totals = state.chat.stats.totals || {};
    var table = el('table', null, [el('tr', null, [el('th',null,['动作']), el('th',null,['次数'])])]);
    Object.keys(totals).forEach(function(k){ table.appendChild(el('tr', null, [el('td',null,[label(k)]), el('td',null,[String(totals[k])])])); });
    if (!Object.keys(totals).length) table.appendChild(el('tr', null, [el('td',{class:'muted'},['暂无记录']), el('td',null,[''])]));
    card.appendChild(table);

    // chatStats.perDay ships in the same response; per-day bars make "哪天开始
    // 不对劲" readable at a glance instead of one number for thirty days.
    var perDay = state.chat.stats.perDay || [];
    if (perDay.length) {
      var byDay = {};
      perDay.forEach(function(r){ byDay[r.day] = (byDay[r.day]||0) + r.n; });
      var days = Object.keys(byDay).sort();
      var dmax = days.reduce(function(m, d){ return Math.max(m, byDay[d]); }, 0);
      card.appendChild(el('h2', {style:'margin-top:14px'}, ['按天']));
      days.forEach(function(d){
        card.appendChild(el('div', {class:'row', style:'padding:3px 0'}, [
          el('span', {style:'width:120px'}, [d]),
          bar(byDay[d], dmax, '#3fb950'),
          el('span', {class:'muted', style:'width:44px;text-align:right'}, [String(byDay[d])])
        ]));
      });
    }

    card.appendChild(el('h2', {style:'margin-top:14px'}, ['最近动作']));
    var log = state.log && state.log.chatId === state.chat.chatId ? state.log : null;
    var kinds = ['','delete','mute','ban','kick','warn','verify','join','leave','block','watch','external','trust'];
    var kindSel = el('select', null, kinds.map(function(k){
      var opt = el('option', {value:k}, [k ? label(k) : '全部类型']);
      if (log && log.kind === k) opt.selected = true;
      return opt;
    }));
    kindSel.addEventListener('change', function(){ loadEvents(state.chat.chatId, 0, kindSel.value); });
    card.appendChild(el('div', {class:'row', style:'margin-bottom:8px'}, [kindSel]));
    var rows = (log && log.events) || (state.chat.events || []);
    var ev = el('table', null, [el('tr', null, [el('th',null,['时间']), el('th',null,['动作']), el('th',null,['对象']), el('th',null,['原因']), el('th',null,['操作人'])])]);
    rows.forEach(function(e){
      ev.appendChild(el('tr', null, [el('td',null,[new Date(e.at).toLocaleString()]), el('td',null,[label(e.kind)]), el('td',null,[String(e.userId||'-')]), el('td',null,[e.reason||'']), el('td',null,[e.byId ? String(e.byId) : '-'])]));
    });
    if (!rows.length) ev.appendChild(el('tr', null, [el('td',{class:'muted'},['没有匹配的记录']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
    card.appendChild(ev);
    if (log && (log.offset > 0 || log.hasMore)) {
      var nav = el('div', {class:'row', style:'margin-top:8px'});
      if (log.offset > 0) nav.appendChild(el('button', {class:'small', onclick:function(){ loadEvents(state.chat.chatId, Math.max(0, log.offset - 20), log.kind); }}, ['← 返回最新']));
      if (log.hasMore) nav.appendChild(el('button', {class:'small', onclick:function(){ loadEvents(state.chat.chatId, log.offset + 20, log.kind); }}, ['更早 →']));
      card.appendChild(nav);
    }
    return card;
  }

  // Small client-side filter for a short in-memory list — the console's
  // notes/filters/schedules rarely exceed a screen, so a search box beats a
  // server round-trip.
  function listFilter(holder, list, renderItems){
    var input = el('input', {type:'search', placeholder:'筛选…', style:'margin-bottom:8px'});
    var render = function(){
      var needle = input.value.trim().toLowerCase();
      clear(list);
      renderItems(list, needle);
    };
    input.addEventListener('input', render);
    holder.appendChild(input);
    holder.appendChild(list);
    render();
  }

  function renderNotes(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['说明（/get 名字）']));
    var name = el('input', {placeholder:'名字'}); var content = el('textarea', {placeholder:'内容'});
    var filterBox = el('div');
    card.appendChild(filterBox);
    listFilter(filterBox, el('div'), function(list, needle){
      (state.chat.notes||[]).filter(function(n){ return !needle || (n.name + ' ' + n.content).toLowerCase().indexOf(needle) >= 0; }).forEach(function(n){
        list.appendChild(el('div', {class:'row', style:'border-bottom:1px solid #1f2a37;padding:6px 0'}, [
          el('b', null, [n.name]), el('span', {class:'muted', style:'flex:1'}, [String(n.content).slice(0,60)]),
          el('button', {class:'small danger', onclick:function(){ api('/api/chat/'+state.chat.chatId+'/note/'+encodeURIComponent(n.name), {method:'DELETE'}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, ['删除'])
        ]));
      });
    });
    card.appendChild(el('div', {style:'height:10px'}));
    card.appendChild(el('div', {class:'row'}, [name]));
    card.appendChild(el('div', {style:'height:8px'}));
    card.appendChild(content);
    card.appendChild(el('div', {style:'height:8px'}));
    card.appendChild(el('button', {class:'primary', onclick:function(){
      if(!name.value) return toast('先填名字');
      api('/api/chat/'+state.chat.chatId+'/note/'+encodeURIComponent(name.value.toLowerCase()), {method:'PUT', body:{content:content.value}}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); });
    }}, ['保存']));
    return card;
  }

  function renderFilters(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['自动回复']));
    var trig = el('input', {placeholder:'触发词'}); var resp = el('input', {placeholder:'回复内容'});
    var mode = el('select', null, [el('option',{value:'exact'},['完全相同']), el('option',{value:'prefix'},['开头匹配']), el('option',{value:'regex'},['正则'])]);
    var filterBox = el('div');
    card.appendChild(filterBox);
    listFilter(filterBox, el('div'), function(list, needle){
      (state.chat.filters||[]).filter(function(f){ return !needle || (f.trigger + ' ' + f.response).toLowerCase().indexOf(needle) >= 0; }).forEach(function(f){
        list.appendChild(el('div', {class:'row', style:'border-bottom:1px solid #1f2a37;padding:6px 0'}, [
          el('span', {class:'pill'}, [f.match]), el('b', null, [f.trigger]), el('span', {class:'muted', style:'flex:1'}, ['→ ' + f.response]),
          el('button', {class:'small danger', onclick:function(){ api('/api/chat/'+state.chat.chatId+'/filter/'+f.id, {method:'DELETE'}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, ['删除'])
        ]));
      });
    });
    card.appendChild(el('div', {class:'row', style:'margin-top:10px'}, [trig, mode, resp]));
    card.appendChild(el('div', {style:'height:8px'}));
    card.appendChild(el('button', {class:'primary', onclick:function(){
      api('/api/chat/'+state.chat.chatId+'/filter', {method:'POST', body:{trigger:trig.value, match:mode.value, response:resp.value}}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); });
    }}, ['添加']));
    return card;
  }

  function renderSched(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['定时消息']));
    var text = el('textarea', {placeholder:'消息内容（支持 HTML）；包含 {{top}} 则发送时替换为今日发言榜'});
    var every = el('input', {type:'number', value:'3600', placeholder:'间隔秒，0=只发一次'});
    var filterBox = el('div');
    card.appendChild(filterBox);
    listFilter(filterBox, el('div'), function(list, needle){
      (state.chat.schedules||[]).filter(function(s){ return !needle || String(s.text).toLowerCase().indexOf(needle) >= 0; }).forEach(function(s){
        list.appendChild(el('div', {class:'row', style:'border-bottom:1px solid #1f2a37;padding:6px 0'}, [
          el('b', null, [String(s.text).slice(0,40)]),
          el('span', {class:'muted', style:'width:110px'}, [s.every>0 ? '每 ' + s.every + 's' : '一次']),
          el('span', {class:'muted', style:'width:130px'}, [new Date(s.nextAt).toLocaleString()]),
          el('span', {class:'pill' + (s.enabled ? ' ok' : '')}, [s.enabled ? '启用' : '停用']),
          el('button', {class:'small', onclick:function(){ api('/api/schedule/'+s.id,{method:'POST',body:{enabled:!s.enabled}}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, [s.enabled?'停用':'启用']),
          el('button', {class:'small danger', onclick:function(){ api('/api/schedule/'+s.id,{method:'DELETE'}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, ['删除'])
        ]));
      });
    });
    card.appendChild(el('div', {style:'height:10px'}));
    card.appendChild(text);
    card.appendChild(el('div', {style:'height:8px'}));
    card.appendChild(el('div', {class:'row'}, [every, el('button', {class:'primary', onclick:function(){
      api('/api/chat/'+state.chat.chatId+'/schedule', {method:'POST', body:{text:text.value, every:Number(every.value)}}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); });
    }}, ['添加（1 分钟后开始）'])]));
    return card;
  }

  function renderBlocks(){
    var card = el('div', {class:'card'});
    var rows = state.chat.blocks || [];
    card.appendChild(el('h2', null, ['屏蔽成员 · ' + rows.length]));
    card.appendChild(el('div', {class:'muted'}, ['屏蔽后机器人静默删除其所有消息：不提示、不计警告，对方不知道自己被屏蔽。']));
    var id = el('input', {placeholder:'用户数字 ID'});
    var reason = el('input', {placeholder:'原因（可选）'});
    card.appendChild(el('div', {class:'row', style:'margin-top:10px'}, [id, reason, el('button', {class:'primary', onclick:function(){
      api('/api/chat/' + state.chat.chatId + '/block', {method:'POST', body:{userId:Number(id.value), reason:reason.value}})
        .then(function(){ toast('已屏蔽'); refreshChat(); })
        .catch(function(e){ toast(e.message); });
    }}, ['屏蔽'])]));
    var table = el('table', null, [el('tr', null, [el('th',null,['用户']), el('th',null,['原因']), el('th',null,['时间']), el('th',null,[''])])]);
    rows.forEach(function(b){
      table.appendChild(el('tr', null, [
        el('td',null,[String(b.userId)]), el('td',null,[b.reason]),
        el('td',null,[new Date(b.at).toLocaleString()]),
        el('td',null,[el('button', {class:'small danger', onclick:function(){
          api('/api/chat/' + state.chat.chatId + '/block/' + b.userId, {method:'DELETE'}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); });
        }}, ['解除'])])
      ]));
    });
    if (!rows.length) table.appendChild(el('tr', null, [el('td',{class:'muted'},['还没有屏蔽任何人']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
    card.appendChild(table);
    return card;
  }

  function renderSync(){
    var card = el('div', {class:'card'});
    var rows = state.chat.sync || [];
    card.appendChild(el('h2', null, ['频道同步 · ' + rows.length]));
    card.appendChild(el('div', {class:'muted'}, ['即时 = 机器人在频道里当管理员，有新帖就转；间隔 = 通过 t.me/s 预览页轮询。私有频道两种都需要先把机器人加进去。']));
    var src = el('input', {placeholder:'@channel 或 https://t.me/channel'});
    var every = el('input', {type:'number', value:'300', placeholder:'间隔秒，0=即时'});
    card.appendChild(el('div', {class:'row', style:'margin-top:10px'}, [src, every, el('button', {class:'primary', onclick:function(){
      api('/api/chat/' + state.chat.chatId + '/sync', {method:'POST', body:{source:src.value, interval:Number(every.value)}})
        .then(function(){ toast('已添加'); refreshChat(); })
        .catch(function(e){ toast(e.message); });
    }}, ['添加'])]));
    var table = el('table', null, [el('tr', null, [el('th',null,['频道']), el('th',null,['频率']), el('th',null,['已转']), el('th',null,['最新']), el('th',null,['状态']), el('th',null,[''])])]);
    rows.forEach(function(r){
      table.appendChild(el('tr', null, [
        el('td',null,['@' + r.source]),
        el('td',null,[r.intervalSeconds > 0 ? r.intervalSeconds + 's' : '即时']),
        el('td',null,[String(r.sent)]), el('td',null,[r.lastId ? '#' + r.lastId : '-']),
        el('td',null,[r.enabled ? '启用' : '停用']),
        el('td',null,[
          el('button', {class:'small', onclick:function(){ api('/api/chat/' + state.chat.chatId + '/sync/' + encodeURIComponent(r.source), {method:'POST', body:{enabled:!r.enabled}}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, [r.enabled ? '停用' : '启用']),
          el('button', {class:'small danger', onclick:function(){ api('/api/chat/' + state.chat.chatId + '/sync/' + encodeURIComponent(r.source), {method:'DELETE'}).then(function(){ refreshChat(); }).catch(function(e){ toast(e.message); }); }}, ['删除'])
        ])
      ]));
    });
    if (!rows.length) table.appendChild(el('tr', null, [el('td',{class:'muted'},['还没有同步任务']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
    card.appendChild(table);
    return card;
  }

  function renderTools(){
    var card = el('div', {class:'card'});
    card.appendChild(el('h2', null, ['工具箱 · 近 30 天']));
    var rows = state.chat.tools || [];
    var table = el('table', null, [el('tr', null, [el('th',null,['工具']), el('th',null,['次数']), el('th',null,['成功']), el('th',null,['文件数'])])]);
    rows.forEach(function(t){
      table.appendChild(el('tr', null, [el('td',null,[t.tool]), el('td',null,[String(t.runs)]), el('td',null,[String(t.ok||0)]), el('td',null,[String(t.bytes||0)])]));
    });
    if (!rows.length) table.appendChild(el('tr', null, [el('td',{class:'muted'},['还没有使用记录']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
    card.appendChild(table);
    card.appendChild(el('div', {class:'muted', style:'margin-top:12px'}, ['群内用法： /splitpdf（回复 PDF）· /slice（回复长图，仅自托管版）· /expand t.me链接 · /ts 1700000000 · /tool 看全部']));
    return card;
  }

  function loadPreset(){
    api('/api/preset').then(function(res){
      var main = document.getElementById('main');
      clear(main);
      var card = el('div', {class:'card'});
      card.appendChild(el('h2', null, ['新群预设 · 首次激活时写入']));
      card.appendChild(el('div', {class:'muted'}, ['只影响此后第一次见到机器人的群；已经建过规则的群不受影响。留空的对象 {} = 全部走内置默认。']));
      var area = el('textarea', {style:'min-height:220px'});
      area.value = JSON.stringify(res.preset || {}, null, 2);
      card.appendChild(area);
      card.appendChild(el('div', {class:'row', style:'margin-top:8px'}, [
        el('button', {class:'primary', onclick:function(){
          var parsed;
          try { parsed = JSON.parse(area.value || '{}'); } catch(e){ return toast('JSON 不合法'); }
          api('/api/preset', {method:'PUT', body: parsed}).then(function(next){
            toast('已保存'); area.value = JSON.stringify(next.preset || {}, null, 2);
          }).catch(function(e){ toast(e.message); });
        }}, ['保存预设']),
        el('button', {onclick:function(){ area.value = '{}'; }}, ['清空（回到内置）'])
      ]));
      card.appendChild(el('h2', {style:'margin-top:16px'}, ['内置基线']));
      var base = el('textarea', {style:'min-height:160px'});
      base.value = JSON.stringify(res.base || {}, null, 2);
      base.disabled = true;
      card.appendChild(base);
      main.appendChild(card);
    }).catch(function(e){ toast(e.message); });
  }

  function exportImportCard(){
    var card = el('details', {class:'card'}, [el('summary', {style:'cursor:pointer;color:var(--muted);font-size:13px'}, ['导出 / 导入整群配置（含说明与自动回复，等价 /export）'])]);
    var importArea = el('textarea', {style:'min-height:120px', placeholder:'粘贴导出的 JSON 后点导入'});
    card.appendChild(el('div', {class:'row', style:'margin-top:10px'}, [
      el('button', {class:'small', onclick:function(){
        api('/api/chat/' + state.chat.chatId + '/export').then(function(data){
          var blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
          var link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'flareward-' + state.chat.chatId + '.json';
          link.click();
          URL.revokeObjectURL(link.href);
        }).catch(function(e){ toast(e.message); });
      }}, ['导出 JSON']),
      el('button', {class:'small', onclick:function(){
        var parsed;
        try { parsed = JSON.parse(importArea.value || '{}'); } catch(e){ return toast('JSON 不合法'); }
        api('/api/chat/' + state.chat.chatId + '/import', {method:'POST', body: parsed})
          .then(function(res){ toast('已导入 ' + (res.applied||0) + ' 项'); refreshChat(); })
          .catch(function(e){ toast(e.message); });
      }}, ['导入'])
    ]));
    card.appendChild(el('div', {style:'height:8px'}));
    card.appendChild(importArea);
    return card;
  }

  var bansState = { q: '', offset: 0, hasMore: false, pageSize: 50 };
  function loadBans(offset){
    var params = new URLSearchParams({ offset: String(offset || 0), limit: String(bansState.pageSize) });
    if (bansState.q) params.set('q', bansState.q);
    api('/api/bans?' + params.toString()).then(function(res){
      bansState.offset = res.offset || 0;
      bansState.hasMore = Boolean(res.hasMore);
      var main = document.getElementById('main');
      clear(main);
      var card = el('div', {class:'card'});
      card.appendChild(el('h2', null, ['全局黑名单' + (bansState.q ? ' · 搜索「' + bansState.q + '」' : '')]));

      // Search by user id fragment or reason; Enter or the button re-queries.
      var search = el('input', {type:'search', placeholder:'搜索用户 ID 或原因', value:bansState.q});
      var doSearch = function(){ bansState.q = search.value.trim(); loadBans(0); };
      search.addEventListener('keydown', function(e){ if(e.key === 'Enter') doSearch(); });
      card.appendChild(el('div', {class:'row', style:'margin-bottom:8px'}, [search, el('button', {class:'small', onclick:doSearch}, ['搜索'])]));

      // Cross-group member audit: every event, warning, block and the global
      // ban row for one person, across every chat the bot knows.
      var lookupId = el('input', {placeholder:'跨群查成员：输入用户 ID'});
      var doLookup = function(){
        var id = lookupId.value.trim();
        if (!id) return;
        api('/api/user/' + id).then(function(res){
          var box = document.getElementById('user-lookup');
          clear(box);
          box.appendChild(el('h3', {style:'margin:12px 0 6px'}, ['成员 ' + res.userId + ' 的跨群记录']));
          if (res.ban) box.appendChild(el('div', {class:'row'}, [el('span', {class:'pill bad'}, ['全局封禁：' + res.ban.reason])]));
          if ((res.warnings||[]).length) {
            var warnCount = res.warnings.reduce(function(m, w){ return m + w.count; }, 0);
            box.appendChild(el('div', {class:'row'}, [el('span', {class:'pill'}, ['警告 ' + warnCount + ' 次 / ' + res.warnings.length + ' 个群'])]));
          }
          var table = el('table', null, [el('tr', null, [el('th',null,['时间']), el('th',null,['群']), el('th',null,['动作']), el('th',null,['原因'])])]);
          (res.events||[]).forEach(function(ev){
            table.appendChild(el('tr', null, [
              el('td',null,[new Date(ev.at).toLocaleString()]),
              el('td',null,[String(ev.chatId)]),
              el('td',null,[ev.kind]),
              el('td',{class:'muted'},[String(ev.reason||'').slice(0,60)])
            ]));
          });
          if (!(res.events||[]).length) table.appendChild(el('tr', null, [el('td',{class:'muted', colspan:'4'},['没有记录'])]));
          box.appendChild(table);
        }).catch(function(e){ toast(e.message); });
      };
      card.appendChild(el('div', {class:'row', style:'margin-top:4px'}, [lookupId, el('button', {class:'small', onclick:doLookup}, ['查成员'])]));
      card.appendChild(el('div', {id:'user-lookup'}));

      var table = el('table', null, [el('tr', null, [el('th',null,['用户']), el('th',null,['来源']), el('th',null,['原因']), el('th',null,['时间']), el('th',null,[''])])]);
      res.bans.forEach(function(b){
        table.appendChild(el('tr', null, [
          el('td',null,[String(b.userId)]), el('td',null,[b.source]), el('td',null,[b.reason]),
          el('td',null,[new Date(b.at).toLocaleString()]),
          el('td', null, [el('button', {class:'small danger', onclick:function(){ api('/api/bans/'+b.userId,{method:'DELETE'}).then(function(){ loadBans(bansState.offset); }).catch(function(e){ toast(e.message); }); }}, ['移出'])])
        ]));
      });
      if (!res.bans.length) table.appendChild(el('tr', null, [el('td',{class:'muted'},['没有匹配的记录']), el('td',null,['']), el('td',null,['']), el('td',null,['']), el('td',null,[''])]));
      card.appendChild(table);
      var nav = el('div', {class:'row', style:'margin-top:8px'});
      if (bansState.offset > 0) nav.appendChild(el('button', {class:'small', onclick:function(){ loadBans(Math.max(0, bansState.offset - bansState.pageSize)); }}, ['← 返回首页']));
      if (bansState.hasMore) nav.appendChild(el('button', {class:'small', onclick:function(){ loadBans(bansState.offset + bansState.pageSize); }}, ['更早 →']));
      if (bansState.offset > 0 || bansState.hasMore) card.appendChild(nav);
      main.appendChild(card);
    }).catch(function(e){ toast(e.message); });
  }

  function boot(){
    var root = document.getElementById('app');
    api('/api/overview').then(function(data){
      state.overview = data;
      renderShell(root);
      // Behind Telegram the console is a phone-sized webview; say so once so a
      // half-width layout reads as "small screen", not "broken page".
      if (TG_INIT && window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
      }
    }).catch(function(e){
      // 401 means "no identity yet" — show the password box with no scary text.
      // Anything else (403 = signed in but not allowed) must be shown as-is:
      // a password prompt would imply retrying could help, and it cannot.
      var unauthorized = e && e.status === 401;
      renderLogin(root, unauthorized ? '' : (e && e.message));
    });
  }
  boot();
})();
</script>
</body></html>`;
}
