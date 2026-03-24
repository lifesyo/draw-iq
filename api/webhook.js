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

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        const firebaseUid = subscription.metadata.firebaseUid || session.metadata?.firebaseUid;
        if (firebaseUid) {
          await db.collection('subscriptions').doc(firebaseUid).set({
            plan: 'pro',
            status: 'active',
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const firebaseUid = subscription.metadata.firebaseUid;
        if (firebaseUid) {
          const isActive = ['active', 'trialing'].includes(subscription.status);
          await db.collection('subscription
