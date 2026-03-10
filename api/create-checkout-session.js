const Stripe = require('stripe');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { priceId, firebaseUid, email } = req.body;

    if (!firebaseUid || !email) {
      return res.status(400).json({ error: 'firebaseUid and email are required' });
    }

    // Check if customer already exists
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { firebaseUID: firebaseUid }
      });
    }

    // Determine price based on priceId
    const isYearly = priceId === 'yearly';
    const unitAmount = isYearly ? 5000 : 500;
    const interval = isYearly ? 'year' : 'month';

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: {
            name: 'Draw IQ Pro',
            description: 'バスケットボール作戦板アプリのプロプラン',
          },
          unit_amount: unitAmount,
          recurring: { interval: interval }
        },
        quantity: 1
      }],
      success_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?canceled=true`,
      metadata: { firebaseUID: firebaseUid }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
