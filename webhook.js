const Stripe = require('stripe');
const admin = require('firebase-admin');

// Firebase Admin初期化（環境変数からサービスアカウント）
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

// Vercel: raw bodyを受け取るための設定
module.exports.config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const firebaseUid = session.metadata?.firebaseUid;
        if (firebaseUid && session.subscription) {
          await db.collection('subscriptions').doc(firebaseUid).set({
            plan: 'pro',
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const firebaseUid = subscription.metadata?.firebaseUid;
        if (firebaseUid) {
          const isActive = ['active', 'trialing'].includes(subscription.status);
          await db.collection('subscriptions').doc(firebaseUid).set({
            plan: isActive ? 'pro' : 'free',
            stripeSubscriptionId: subscription.id,
            status: subscription.status,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const firebaseUid = subscription.metadata?.firebaseUid;
        if (firebaseUid) {
          await db.collection('subscriptions').doc(firebaseUid).set({
            plan: 'free',
            status: 'canceled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subscription = invoice.subscription
          ? await stripe.subscriptions.retrieve(invoice.subscription)
          : null;
        if (subscription?.metadata?.firebaseUid) {
          await db.collection('subscriptions').doc(subscription.metadata.firebaseUid).set({
            plan: 'free',
            status: 'payment_failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  res.status(200).json({ received: true });
};
