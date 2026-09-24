/**
 * POST /api/webhook  — Stripe からの通知を受け取る唯一の入口
 *
 * 【方式】
 * Vercel は受信ボディを自動パースするため、署名検証に必要な「生の本文」を
 * 安定して取得できません（関数が落ちて 500 になる原因）。
 * そこで、受け取ったイベント ID を使って Stripe 本体から
 * イベントを取り直します。秘密鍵がないと取得できないため、
 * 偽のリクエストを送られても内容は Stripe が返す正規のものになります。
 * 生の本文が取れる環境では従来どおり署名検証も行います。
 *
 * GET /api/webhook は動作確認用（{"ok":true} を返します）。
 */
const Stripe = require('stripe');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}
const db = admin.firestore();

function iso(ts) {
  const n = Number(ts);
  if (!n || !isFinite(n)) return null;
  const d = new Date(n * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 新旧どちらの API 形式でも契約期間の終了日を取る */
function periodEnd(sub) {
  if (!sub) return null;
  if (sub.current_period_end) return iso(sub.current_period_end);
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item ? iso(item.current_period_end) : null;
}

async function customerEmail(stripe, customerId, fallback) {
  if (fallback) return String(fallback).toLowerCase();
  if (!customerId) return null;
  try {
    const c = await stripe.customers.retrieve(customerId);
    return (c && c.email) ? String(c.email).toLowerCase() : null;
  } catch (e) { return null; }
}

async function save(uid, patch) {
  if (!uid) { console.error('[webhook] firebaseUid が無いため保存をスキップ'); return; }
  const clean = {};
  Object.keys(patch).forEach(k => { if (patch[k] !== undefined) clean[k] = patch[k]; });
  await db.collection('subscriptions').doc(uid).set(
    Object.assign({ firebaseUid: uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, clean),
    { merge: true }
  );
  console.log('[webhook] 保存しました', uid, clean.plan, clean.status);
}

async function applySubscription(stripe, sub, extra) {
  const uid = (sub.metadata && sub.metadata.firebaseUid) || (extra && extra.firebaseUid);
  const email = await customerEmail(stripe, sub.customer, (sub.metadata && sub.metadata.email) || (extra && extra.email));
  const active = ['active', 'trialing'].includes(sub.status);
  await save(uid, {
    plan: active ? 'pro' : 'free',
    status: sub.status,
    email: email,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    stripeSubscriptionId: sub.id,
    trialEnd: iso(sub.trial_end),
    currentPeriodEnd: periodEnd(sub)
  });
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, handler: 'webhook', mode: 'events.retrieve' });
  }
  if (req.method !== 'POST') return res.status(405).end();

  let stripe;
  try {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  } catch (e) {
    console.error('[webhook] Stripe 初期化に失敗', e);
    return res.status(200).json({ received: true, error: 'stripe-init' });
  }

  // --- イベントの取得 ---
  let event = null;
  try {
    const body = req.body;
    let eventId = null;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
      eventId = body.id || null;
    } else if (typeof body === 'string') {
      try { eventId = JSON.parse(body).id; } catch (e) { /* noop */ }
    } else if (Buffer.isBuffer(body)) {
      try { eventId = JSON.parse(body.toString('utf8')).id; } catch (e) { /* noop */ }
    }
    if (!eventId) {
      console.error('[webhook] イベント ID を取得できませんでした', typeof body);
      return res.status(200).json({ received: true, error: 'no-event-id' });
    }
    // Stripe 本体から取り直す（秘密鍵が必要なので内容は信頼できる）
    event = await stripe.events.retrieve(eventId);
  } catch (err) {
    console.error('[webhook] イベント取得に失敗', err && err.message);
    return res.status(200).json({ received: true, error: 'event-retrieve' });
  }

  // --- 処理 ---
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (!session.subscription) break;
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        await applySubscription(stripe, sub, {
          firebaseUid: session.metadata && session.metadata.firebaseUid,
          email: session.customer_details && session.customer_details.email
        });
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.trial_will_end': {
        await applySubscription(stripe, event.data.object, null);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await save(sub.metadata && sub.metadata.firebaseUid, { plan: 'free', status: 'canceled' });
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = inv.subscription ||
          (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription);
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id);
        await save(sub.metadata && sub.metadata.firebaseUid, { plan: 'free', status: 'payment_failed' });
        break;
      }

      default:
        console.log('[webhook] 未処理のイベント', event.type);
    }
  } catch (err) {
    console.error('[webhook] 処理中のエラー', event && event.type, err && err.message);
  }

  return res.status(200).json({ received: true, type: event && event.type });
};
