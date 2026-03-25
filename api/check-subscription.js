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
 
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
 
  try {
    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ error: 'Missing uid' });
 
    const doc = await db.collection('subscriptions').doc(uid).get();
    if (!doc.exists) {
      return res.status(200).json({ plan: 'free' });
    }
 
    const data = doc.data();
    res.status(200).json({
      plan: data.plan || 'free',
      status: data.status || null,
      stripeCustomerId: data.stripeCustomerId || null,
      currentPeriodEnd: data.currentPeriodEnd || null
    });
  } catch (err) {
    console.error('check-subscription error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
 
