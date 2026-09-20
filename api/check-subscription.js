/**
 * GET /api/check-subscription?uid=<firebaseUid>&email=<mail>
 *
 * 返り値: { plan:'pro'|'free', status, source:'stripe'|'comp'|null, stripeCustomerId, currentPeriodEnd }
 *
 * source:'comp' は「課金せずに利用できるアカウント」。環境変数で指定します。
 *   IQ_COMP_EMAILS = "owner@example.com,staff@example.com"
 *   IQ_COMP_UIDS   = "tmpnW0YjuuUf1KbNPTC9H6ffnRG2"
 * コードに書かないので、追加・削除はVercelの環境変数だけで済みます。
 *
 * email での検索は、Firebaseプロジェクトが別のアプリ（Play IQ）から
 * 共通の subscriptions コレクションを引くために使います。
 */
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

function toList(v) {
  return (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const uid = req.query.uid || '';
    let email = (req.query.email || '').toLowerCase();
    if (!uid && !email) return res.status(400).json({ error: 'Missing uid or email' });

    // uid しか渡ってこない場合、同一プロジェクトならメールアドレスを引ける
    if (!email && uid) {
      try {
        const u = await admin.auth().getUser(uid);
        email = (u.email || '').toLowerCase();
      } catch (e) { /* 別プロジェクトのuidなら引けない。想定内 */ }
    }

    // --- 無償利用アカウント（オーナーなど） ---
    const compUids = toList(process.env.IQ_COMP_UIDS);
    const compEmails = toList(process.env.IQ_COMP_EMAILS);
    if ((uid && compUids.includes(uid.toLowerCase())) || (email && compEmails.includes(email))) {
      return res.status(200).json({
        plan: 'pro', status: 'active', source: 'comp',
        stripeCustomerId: null, currentPeriodEnd: null
      });
    }

    // --- uid で直接引く（Draw IQ / Stat IQ） ---
    if (uid) {
      const doc = await db.collection('subscriptions').doc(uid).get();
      if (doc.exists) {
        const d = doc.data();
        return res.status(200).json({
          plan: d.plan || 'free',
          status: d.status || null,
          source: (d.plan === 'pro') ? 'stripe' : null,
          stripeCustomerId: d.stripeCustomerId || null,
          currentPeriodEnd: d.currentPeriodEnd || null
        });
      }
    }

    // --- email で引く（別Firebaseプロジェクトのアプリ用） ---
    if (email) {
      const snap = await db.collection('subscriptions')
        .where('email', '==', email).limit(1).get();
      if (!snap.empty) {
        const d = snap.docs[0].data();
        return res.status(200).json({
          plan: d.plan || 'free',
          status: d.status || null,
          source: (d.plan === 'pro') ? 'stripe' : null,
          stripeCustomerId: d.stripeCustomerId || null,
          currentPeriodEnd: d.currentPeriodEnd || null
        });
      }
    }

    return res.status(200).json({ plan: 'free', status: null, source: null });
  } catch (err) {
    console.error('check-subscription error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
