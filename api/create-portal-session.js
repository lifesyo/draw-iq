/**
 * POST /api/create-portal-session
 * header: Authorization: Bearer <Firebase IDトークン>
 *
 * Stripe のカスタマーポータル（契約内容の変更・解約・領収書）を開きます。
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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    const uid = decoded.uid;

    // subscriptions を正とし、古い customers コレクションも一応見る
    let stripeCustomerId = null;
    const subDoc = await db.collection('subscriptions').doc(uid).get();
    if (subDoc.exists) stripeCustomerId = subDoc.data().stripeCustomerId || null;
    if (!stripeCustomerId) {
      const cusDoc = await db.collection('customers').doc(uid).get();
      if (cusDoc.exists) stripeCustomerId = cusDoc.data().stripeCustomerId || null;
    }
    // それでも見つからなければメールアドレスから探す
    if (!stripeCustomerId && decoded.email) {
      const list = await stripe.customers.list({ email: decoded.email, limit: 1 });
      if (list.data.length) stripeCustomerId = list.data[0].id;
    }
    if (!stripeCustomerId) return res.status(404).json({ error: 'No subscription found' });

    const origin = req.headers.origin || ('https://' + (req.headers.host || ''));
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: origin
    });
    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Portal session error:', error);
    return res.status(500).json({ error: 'Failed to create portal session' });
  }
};
