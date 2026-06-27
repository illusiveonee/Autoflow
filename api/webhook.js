// /api/webhook.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // 1. Verify it's a POST from Stripe
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 2. Get the Stripe signature from headers
  const sig = req.headers['stripe-signature'];
  if (!sig) {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  // 3. Verify webhook secret is set
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  // 4. Verify the event is legit
  let event;
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Invalid signature: ${err.message}` });
  }

  // 5. Handle the event
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerEmail = session.customer_email;
        const amount = session.amount_total / 100; // convert cents to dollars
        const planName = session.metadata?.plan || 'Full Suite';

        // Store subscriber in Vercel KV
        const subscriber = {
          email: customerEmail,
          plan: planName,
          amount: amount,
          status: 'active',
          created: new Date().toISOString(),
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        };

        // Get existing subscribers, append, save
        const existing = (await kv.get('subscribers')) || [];
        // Avoid duplicates by email
        const filtered = existing.filter(s => s.email !== customerEmail);
        filtered.push(subscriber);
        await kv.set('subscribers', filtered);

        // Update MRR stats
        await updateStats();

        console.log(`✅ New subscriber: ${customerEmail} ($${amount}/mo)`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerEmail = subscription.customer_email;

        const existing = (await kv.get('subscribers')) || [];
        const updated = existing.map(s =>
          s.email === customerEmail ? { ...s, status: 'cancelled' } : s
        );
        await kv.set('subscribers', updated);
        await updateStats();

        console.log(`❌ Subscription cancelled: ${customerEmail}`);
        break;
      }

      case 'invoice.payment_succeeded': {
        // Optionally update last_payment date
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Helper: Recalculate MRR, subscriber count, etc., and save to KV
async function updateStats() {
  const subscribers = (await kv.get('subscribers')) || [];
  const active = subscribers.filter(s => s.status === 'active');
  const mrr = active.reduce((sum, s) => sum + (s.amount || 0), 0);

  await kv.set('stats', {
    mrr,
    subscribers: active.length,
    prospects: (await kv.get('prospects'))?.length || 0,
    emailsSent: (await kv.get('emailsSent')) || 0,
    revenueHistory: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // you can expand this
    updatedAt: new Date().toISOString(),
  });
}
