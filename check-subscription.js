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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { firebaseUid } = req.body;
    if (!firebaseUid) return res.status(400).json({ error: 'Missing firebaseUid' });

    const doc = await db.collection('subscriptions').doc(firebaseUid).get();
    if (!doc.exists) {
      return res.status(200).json({ plan: 'free' });
    }

    const data = doc.data();
    res.status(200).json({
      plan: data.plan || 'free',
      status: data.status || null,
      currentPeriodEnd: data.currentPeriodEnd || null
    });
  } catch (err) {
    console.error('Check subscription error:', err);
    res.status(500).json({ error: err.message });
  }
};
