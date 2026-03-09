const Stripe = require('stripe');

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { priceId, firebaseUid, email } = req.body;
    if (!priceId || !firebaseUid) {
      return res.status(400).json({ error: 'Missing priceId or firebaseUid' });
    }

    // 既存のStripe Customerを検索、なければ作成
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { firebaseUid }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?payment=success`,
      cancel_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?payment=cancelled`,
      metadata: { firebaseUid },
      subscription_data: {
        metadata: { firebaseUid }
      }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
