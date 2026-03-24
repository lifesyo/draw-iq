const Stripe = require('stripe');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    const { stripeCustomerId } = req.body;
    if (!stripeCustomerId) return res.status(400).json({ error: 'Missing stripeCustomerId' });

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: req.headers.origin || 'https://draw-iq-iota.vercel.app'
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: err.message });
  }
};
