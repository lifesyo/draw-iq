/*!
 * IQ Series 共通課金モジュール  v1.0
 * -------------------------------------------------------------
 * 使い方（各アプリの index.html）
 *
 *   <script src="/iq-billing.js"></script>
 *   <script>
 *     IQBilling.init({
 *       app: 'stat-iq',
 *       priceMonthly: 'price_xxx',
 *       priceYearly:  'price_yyy',
 *       ownerUids: ['tmpnW0YjuuUf1KbNPTC9H6ffnRG2']
 *     });
 *   </script>
 *
 *   // Firebase の onAuthStateChanged の中で
 *   IQBilling.setUser(user);
 *
 *   // 有料機能の入口で
 *   if(!IQBilling.requirePro()) return;
 *
 * 注意：このモジュールの判定はクライアント側です。開発者ツールを
 * 使えば回避できます。決済そのものは Stripe 側で正しく処理される
 * ため実害は限定的ですが、厳密に守りたい機能はサーバー側でも
 * check-subscription を呼んで確認してください。
 */
(function (global) {
  'use strict';

  var cfg = {
    app: 'iq',
    apiBase: '',
    priceMonthly: null,
    priceYearly: null,
    ownerUids: [],
    checkoutEnabled: true,
    subscribeUrl: null,       // checkoutEnabled:false のとき、購読ページへ誘導する
    manageFrom: null,         // 契約管理を別アプリに任せる場合のURL
    badgeSelector: '#iq-plan-badge',
    autoBadge: true,          // 上のidが無ければ右下に自動表示
    trialDays: 14
  };

  var state = {
    user: null,
    plan: 'free',
    source: null,             // 'stripe' | 'comp' | 'offline'
    stripeCustomerId: null,
    currentPeriodEnd: null,
    ready: false
  };

  var listeners = [];
  var LSKEY = function () { return 'iq_' + cfg.app + '_owner_pro'; };

  /* ---------------- styles & modal ---------------- */

  var CSS = [
    '.iqb-badge{display:inline-block;font:700 11px/1 system-ui,sans-serif;letter-spacing:.08em;',
    'padding:5px 9px;border-radius:999px;cursor:pointer;vertical-align:middle;user-select:none}',
    '.iqb-badge.free{background:#e2e6ec;color:#5b6472}',
    '.iqb-badge.pro{background:#1B3A6B;color:#fff}',
    '.iqb-badge.comp{background:#D9701F;color:#fff}',
    '.iqb-overlay{position:fixed;inset:0;background:rgba(10,14,20,.62);z-index:99999;',
    'display:flex;align-items:center;justify-content:center;padding:18px}',
    '.iqb-modal{background:#fff;color:#161A21;border-radius:16px;max-width:430px;width:100%;',
    'padding:26px 24px 22px;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;',
    'box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow:auto}',
    '.iqb-modal h2{margin:0 0 6px;font-size:19px;line-height:1.5}',
    '.iqb-modal p{margin:0 0 16px;font-size:13.5px;line-height:1.8;color:#4A515E}',
    '.iqb-plan{display:flex;gap:10px;margin-bottom:14px}',
    '.iqb-plan button{flex:1;border:1.5px solid #D6DAE2;background:#fff;border-radius:12px;',
    'padding:14px 10px;cursor:pointer;text-align:center;font-family:inherit;transition:border-color .15s}',
    '.iqb-plan button:hover{border-color:#1B3A6B}',
    '.iqb-plan .t{font-size:12px;color:#7A8290;display:block;margin-bottom:3px}',
    '.iqb-plan .v{font-size:20px;font-weight:700;letter-spacing:-.01em}',
    '.iqb-plan .s{font-size:11px;color:#7A8290;display:block;margin-top:3px}',
    '.iqb-note{font-size:12px;color:#7A8290;line-height:1.7;margin:0 0 14px}',
    '.iqb-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end}',
    '.iqb-actions button{font-family:inherit;font-size:13.5px;border-radius:999px;cursor:pointer;padding:10px 18px}',
    '.iqb-close{background:none;border:none;color:#5b6472}',
    '.iqb-go{background:#1B3A6B;color:#fff;border:none;font-weight:700}',
    '@media(prefers-color-scheme:dark){.iqb-modal{background:#161C25;color:#E9EDF3}',
    '.iqb-modal p{color:#AAB4C2}.iqb-plan button{background:#1E2632;border-color:#2A3441;color:#E9EDF3}}'
  ].join('');

  function injectCss() {
    if (document.getElementById('iqb-css')) return;
    var st = document.createElement('style');
    st.id = 'iqb-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function yen(n) { return n.toLocaleString('ja-JP'); }

  function showUpgrade() {
    injectCss();
    var old = document.getElementById('iqb-overlay');
    if (old) old.remove();

    var ov = document.createElement('div');
    ov.className = 'iqb-overlay';
    ov.id = 'iqb-overlay';

    var body;
    if (cfg.checkoutEnabled) {
      body =
        '<div class="iqb-plan">' +
        '<button type="button" data-price="' + (cfg.priceMonthly || '') + '">' +
        '<span class="t">月払い</span><span class="v">' + yen(980) + '円</span><span class="s">毎月</span></button>' +
        '<button type="button" data-price="' + (cfg.priceYearly || '') + '">' +
        '<span class="t">年払い</span><span class="v">' + yen(9800) + '円</span><span class="s">2か月ぶんおトク</span></button>' +
        '</div>' +
        '<p class="iqb-note">最初の' + cfg.trialDays + '日間は無料です。期間中に解約すれば料金はかかりません。' +
        'Draw IQ / Stat IQ / Play IQ の3つすべてが対象です。</p>' +
        '<div class="iqb-actions"><button type="button" class="iqb-close">閉じる</button></div>';
    } else {
      body =
        '<p class="iqb-note">このアプリの契約手続きは IQ Series の購読ページから行えます。' +
        '一度ご契約いただくと、Draw IQ / Stat IQ / Play IQ の3つすべてが使えるようになります。</p>' +
        '<div class="iqb-actions"><button type="button" class="iqb-close">閉じる</button>' +
        '<button type="button" class="iqb-go">購読ページを開く</button></div>';
    }

    ov.innerHTML =
      '<div class="iqb-modal" role="dialog" aria-modal="true" aria-label="IQ Series のご契約">' +
      '<h2>IQ Series のご契約が必要です</h2>' +
      '<p>この機能をお使いいただくには、IQ Series のご契約が必要です。</p>' +
      body + '</div>';

    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.classList.contains('iqb-close')) ov.remove();
      if (e.target.classList.contains('iqb-go') && cfg.subscribeUrl) {
        global.open(cfg.subscribeUrl, '_blank', 'noopener');
      }
      var b = e.target.closest ? e.target.closest('button[data-price]') : null;
      if (b && b.dataset.price) { startCheckout(b.dataset.price); }
    });

    document.body.appendChild(ov);
  }

  function closeUpgrade() {
    var ov = document.getElementById('iqb-overlay');
    if (ov) ov.remove();
  }

  /* ---------------- entitlement ---------------- */

  function notify() {
    listeners.forEach(function (fn) { try { fn(state.plan, state); } catch (e) { console.error(e); } });
    renderBadge();
  }

  function ensureBadgeEl() {
    var el = document.querySelector(cfg.badgeSelector);
    if (el) return el;
    if (!cfg.autoBadge || !document.body) return null;
    el = document.getElementById('iqb-auto-badge');
    if (!el) {
      el = document.createElement('span');
      el.id = 'iqb-auto-badge';
      el.className = 'iqb-badge free';
      el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9998;box-shadow:0 2px 10px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    return el;
  }

  function renderBadge() {
    var el = ensureBadgeEl();
    if (!el) return;
    var isComp = state.source === 'comp';
    el.className = 'iqb-badge ' + (isComp ? 'comp' : (state.plan === 'pro' ? 'pro' : 'free'));
    el.textContent = isComp ? 'OWNER' : (state.plan === 'pro' ? 'PRO' : 'FREE');
    el.title = isComp ? 'オーナーアカウント（課金なしでご利用いただけます）'
      : (state.plan === 'pro' ? 'ご契約中です' : 'クリックしてご契約手続きへ');
    if (!el._iqbBound) {
      el._iqbBound = true;
      el.addEventListener('click', function () {
        if (isComp) return;
        if (state.plan === 'pro') { openPortal(); } else { showUpgrade(); }
      });
    }
  }

  function setLocalOwnerFlag(on) {
    try { on ? localStorage.setItem(LSKEY(), '1') : localStorage.removeItem(LSKEY()); } catch (e) { }
  }
  function getLocalOwnerFlag() {
    try { return localStorage.getItem(LSKEY()) === '1'; } catch (e) { return false; }
  }

  async function refresh() {
    // ログインしていないとき：オーナーだけはオフラインでも維持する
    if (!state.user) {
      state.plan = getLocalOwnerFlag() ? 'pro' : 'free';
      state.source = getLocalOwnerFlag() ? 'comp' : null;
      state.ready = true;
      notify();
      return state.plan;
    }

    // 端末側のオーナー判定（オフライン時の保険）
    if (cfg.ownerUids.indexOf(state.user.uid) !== -1) {
      state.plan = 'pro'; state.source = 'comp';
      setLocalOwnerFlag(true);
      state.ready = true;
      notify();
      return state.plan;
    }

    try {
      var q = 'uid=' + encodeURIComponent(state.user.uid);
      if (state.user.email) q += '&email=' + encodeURIComponent(state.user.email);
      var r = await fetch(cfg.apiBase + '/api/check-subscription?' + q, { cache: 'no-store' });
      var d = await r.json();
      state.plan = d.plan || 'free';
      state.source = d.source || (state.plan === 'pro' ? 'stripe' : null);
      state.stripeCustomerId = d.stripeCustomerId || null;
      state.currentPeriodEnd = d.currentPeriodEnd || null;
      setLocalOwnerFlag(state.source === 'comp');
    } catch (e) {
      console.error('[IQBilling] check-subscription 失敗', e);
      // 通信できないときは端末に残っているオーナーフラグのみ尊重する
      state.plan = getLocalOwnerFlag() ? 'pro' : 'free';
      state.source = getLocalOwnerFlag() ? 'comp' : null;
    }
    state.ready = true;
    notify();
    return state.plan;
  }

  /* ---------------- stripe ---------------- */

  async function startCheckout(priceId) {
    if (!cfg.checkoutEnabled) {
      if (cfg.subscribeUrl) global.open(cfg.subscribeUrl, '_blank', 'noopener');
      return;
    }
    if (!state.user) { alert('先に Google でログインしてください。'); return; }
    if (!priceId) { alert('料金プランが設定されていません。'); return; }
    try {
      var r = await fetch(cfg.apiBase + '/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: priceId,
          firebaseUid: state.user.uid,
          email: state.user.email,
          trialDays: cfg.trialDays
        })
      });
      var d = await r.json();
      if (d.url) { global.location.href = d.url; }
      else { alert('決済ページを開けませんでした：' + (d.error || '不明なエラー')); }
    } catch (e) {
      console.error('[IQBilling] checkout 失敗', e);
      alert('決済ページを開けませんでした。通信状況をご確認ください。');
    }
  }

  async function openPortal() {
    if (state.source === 'comp') { alert('オーナーアカウントのため、契約の手続きは不要です。'); return; }
    if (cfg.manageFrom) { global.open(cfg.manageFrom, '_blank', 'noopener'); return; }
    if (!state.user || !global.__iqbGetIdToken) {
      alert('契約の管理画面を開けませんでした。ログイン状態をご確認ください。');
      return;
    }
    try {
      var token = await global.__iqbGetIdToken();
      var r = await fetch(cfg.apiBase + '/api/create-portal-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
      });
      var d = await r.json();
      if (d.url) { global.location.href = d.url; }
      else { alert('契約の管理画面を開けませんでした：' + (d.error || '不明なエラー')); }
    } catch (e) {
      console.error('[IQBilling] portal 失敗', e);
      alert('契約の管理画面を開けませんでした。');
    }
  }

  /* ---------------- public api ---------------- */

  var IQBilling = {
    init: function (options) {
      Object.keys(options || {}).forEach(function (k) { cfg[k] = options[k]; });
      injectCss();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderBadge);
      } else { renderBadge(); }
      // 決済から戻ってきた直後は Webhook 反映待ちで数秒かかることがある
      if (/[?&]checkout=success/.test(global.location.search)) {
        var tries = 0;
        var poll = setInterval(async function () {
          tries++;
          await refresh();
          if (state.plan === 'pro' || tries >= 8) clearInterval(poll);
        }, 1500);
      }
      return IQBilling;
    },
    setUser: function (user) {
      state.user = user ? { uid: user.uid, email: user.email || null } : null;
      return refresh();
    },
    refresh: refresh,
    isPro: function () { return state.plan === 'pro'; },
    isOwner: function () { return state.source === 'comp'; },
    isReady: function () { return state.ready; },
    plan: function () { return state.plan; },
    /** 有料機能の入口で使う。false が返ったら処理を中断する */
    requirePro: function () {
      if (state.plan === 'pro') return true;
      showUpgrade();
      return false;
    },
    showUpgrade: showUpgrade,
    closeUpgrade: closeUpgrade,
    openPortal: openPortal,
    startCheckout: startCheckout,
    onChange: function (fn) { listeners.push(fn); if (state.ready) fn(state.plan, state); return IQBilling; }
  };

  global.IQBilling = IQBilling;
})(window);
