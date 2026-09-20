/**
 * POST /api/create-checkout-session
 * body: { priceId, firebaseUid, email, trialDays }
 *
 * 無料お試し期間は trialDays（既定14日）。Stripe側で日数を管理するので、
 * アプリ側に試用期間の状態を持つ必要はありません。
 */
const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { priceId, firebaseUid, email } = req.body || {};
    if (!priceId || !firebaseUid || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const trialDays = Number(process.env.IQ_TRIAL_DAYS || (req.body && req.body.trialDays) || 14);

    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
      if (!customer.metadata.firebaseUid) {
        await stripe.customers.update(customer.id, { metadata: { firebaseUid } });
      }
    } else {
      customer = await stripe.customers.create({ email, metadata: { firebaseUid } });
    }

    const origin = req.headers.origin || ('https://' + (req.headers.host || ''));

    const subscriptionData = { metadata: { firebaseUid, email } };
    // すでに試用済みの顧客に再度トライアルを与えない
    const past = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 1 });
    if (trialDays > 0 && past.data.length === 0) {
      subscriptionData.trial_period_days = trialDays;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: subscriptionData,
      success_url: `${origin}?checkout=success`,
      cancel_url: `${origin}?checkout=cancel`,
      allow_promotion_codes: true
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
