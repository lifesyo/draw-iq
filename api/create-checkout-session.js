const Stripe = require('stripe');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const { uid, email } = req.body;

    if (!uid || !email) {
      return res.status(400).json({ error: 'uid and email are required' });
    }

    // Check if customer already exists
    const customers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (customers.data.length > 0) {
      customer = customers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        metadata: { firebaseUID: uid }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'jpy',
          product_data: {
            name: 'Draw IQ Pro',
            description: 'ãƒã‚¹ã‚±ä½œæˆ¦æ¿ãƒ—ãƒ­ãƒ—ãƒ©ãƒ³'
          },
          unit_amount: 500,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      success_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || 'https://draw-iq-iota.vercel.app'}?canceled=true`,
      metadata: { firebaseUID: uid }
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
};
