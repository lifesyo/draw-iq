/**
 * POST /api/webhook  （Stripe からの通知を受け取る唯一の入口）
 *
 * 変更点：subscriptions ドキュメントに email と firebaseUid を保存します。
 * これにより、Firebaseプロジェクトが別の Play IQ からも
 * メールアドレスで契約状態を引けるようになります。
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

/** Stripeの顧客IDからメールアドレスを取る（失敗しても止めない） */
async function customerEmail(stripe, customerId, fallback) {
  if (fallback) return String(fallback).toLowerCase();
  try {
    const c = await stripe.customers.retrieve(customerId);
    return (c && c.email) ? String(c.email).toLowerCase() : null;
  } catch (e) { return null; }
}

async function save(uid, patch) {
  if (!uid) return;
  await db.collection('subscriptions').doc(uid).set(
    Object.assign({ firebaseUid: uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, patch),
    { merge: true }
  );
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
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const uid = subscription.metadata.firebaseUid || (session.metadata && session.metadata.firebaseUid);
        const email = await customerEmail(
          stripe, session.customer,
          subscription.metadata.email || session.customer_details?.email
        );
        // trialing も利用可とする
        const active = ['active', 'trialing'].includes(subscription.status);
        await save(uid, {
          plan: active ? 'pro' : 'free',
          status: subscription.status,
          email: email,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
          trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString()
        });
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const uid = sub.metadata.firebaseUid;
        const email = await customerEmail(stripe, sub.customer, sub.metadata.email);
        const active = ['active', 'trialing'].includes(sub.status);
        await save(uid, {
          plan: active ? 'pro' : 'free',
          status: sub.status,
          email: email,
          stripeCustomerId: sub.customer,
          trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          currentPeriodEnd: new Date(sub.current_period_end * 1000).toISOString()
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await save(sub.metadata.firebaseUid, { plan: 'free', status: 'canceled' });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const sub = invoice.subscription ? await stripe.subscriptions.retrieve(invoice.subscription) : null;
        if (sub && sub.metadata && sub.metadata.firebaseUid) {
          await save(sub.metadata.firebaseUid, { plan: 'free', status: 'payment_failed' });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.status(200).json({ received: true });
};

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
