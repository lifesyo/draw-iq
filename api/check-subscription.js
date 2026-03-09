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

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = req.query.uid;
  if (!uid) {
    return res.status(400).json({ error: 'uid is required' });
  }

  try {
    const db = admin.firestore();
    const doc = await db.collection('subscriptions').doc(uid).get();

    if (!doc.exists) {
      return res.status(200).json({ status: 'free', plan: 'free' });
    }

    const data = doc.data();
    res.status(200).json({
      status: data.status || 'free',
      plan: data.status === 'active' ? 'pro' : 'free'
    });
  } catch (err) {
    console.error('Check subscription error:', err);
    res.status(500).json({ error: err.message });
  }
};
