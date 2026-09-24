/**
 * POST /api/webhook  （Stripe からの通知を受け取る唯一の入口）
 *
 * 2026-02-25 以降の Stripe API では current_period_end が
 * サブスクリプション本体ではなく items[].current_period_end に移動しました。
 * 日付が取れないときに例外で処理全体が止まらないよう、すべて安全に扱います。
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

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** UNIX秒 → ISO文字列。取れなければ null（例外を出さない） */
function iso(ts) {
  const n = Number(ts);
  if (!n || !isFinite(n)) return null;
  const d = new Date(n * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** 新旧どちらの API でも期間終了日を取る */
function periodEnd(sub) {
  if (!sub) return null;
  if (sub.current_period_end) return iso(sub.current_period_end);
  const item = sub.items && sub.items.data && sub.items.data[0];
  return item ? iso(item.current_period_end) : null;
}

async function customerEmail(stripe, customerId, fallback) {
  if (fallback) return String(fallback).toLowerCase();
  try {
    const c = await stripe.customers.retrieve(customerId);
    return (c && c.email) ? String(c.email).toLowerCase() : null;
  } catch (e) { return null; }
}

async function save(uid, patch) {
  if (!uid) { console.error('save skipped: firebaseUid missing'); return; }
  const clean = {};
  Object.keys(patch).forEach(k => { if (patch[k] !== undefined) clean[k] = patch[k]; });
  await db.collection('subscriptions').doc(uid).set(
    Object.assign({ firebaseUid: uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, clean),
    { merge: true }
  );
  console.log('subscription saved', uid, clean.plan, clean.status);
}

const handler = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (!session.subscription) break;
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const uid = sub.metadata.firebaseUid || (session.metadata && session.metadata.firebaseUid);
        const email = await customerEmail(
          stripe, session.customer,
          sub.metadata.email || (session.customer_details && session.customer_details.email)
        );
        const active = ['active', 'trialing'].includes(sub.status);
        await save(uid, {
          plan: active ? 'pro' : 'free',
          status: sub.status,
          email: email,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          trialEnd: iso(sub.trial_end),
          currentPeriodEnd: periodEnd(sub)
        });
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.firebaseUid;
        const email = await customerEmail(stripe, sub.customer, sub.metadata && sub.metadata.email);
        const active = ['active', 'trialing'].includes(sub.status);
        await save(uid, {
          plan: active ? 'pro' : 'free',
          status: sub.status,
          email: email,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          trialEnd: iso(sub.trial_end),
          currentPeriodEnd: periodEnd(sub)
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await save(sub.metadata && sub.metadata.firebaseUid, { plan: 'free', status: 'canceled' });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription ||
          (invoice.parent && invoice.parent.subscription_details && invoice.parent.subscription_details.subscription);
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(subId);
        if (sub && sub.metadata && sub.metadata.firebaseUid) {
          await save(sub.metadata.firebaseUid, { plan: 'free', status: 'payment_failed' });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', event && event.type, err);
  }

  res.status(200).json({ received: true });
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
