const Stripe = require('stripe');

// Firebase Admin SDK setup
let admin;
try {
  admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
      })
    });
  }
} catch (e) {
  console.error('Firebase Admin init error:', e);
}

// Disable body parsing for webhook signature verification
module.exports.config = { api: { bodyParser: false } };

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const db = admin.firestore();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata?.firebaseUID;
        if (uid) {
          await db.collection('subscriptions').doc(uid).set({
            status: 'active',
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            plan: 'pro',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        // Find user by stripeCustomerId
        const snap = await db.collection('subscriptions')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          await doc.ref.update({
            status: subscription.status === 'active' ? 'active' : subscription.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const snap = await db.collection('subscriptions')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          await doc.ref.update({
            status: 'canceled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const snap = await db.collection('subscriptions')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!snap.empty) {
          const doc = snap.docs[0];
          await doc.ref.update({
            status: 'past_due',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.status(200).json({ received: true });
};
